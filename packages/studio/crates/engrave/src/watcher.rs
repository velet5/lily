//! Watches the files on disk behind Lily Studio (DECISIONS D34): those open in the editor, and the score
//! compiled last with everything it `\include`s, plus where its missing
//! includes would appear. A change another program made is reported once it
//! settles; the studio's own saves are not changes.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::paths;
use crate::root_file::{IncludeOptions, include_graph};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FileChange {
    /// The path the editor opened it under, else its canonical path.
    pub file: PathBuf,
    /// False when the file is gone.
    pub exists: bool,
}

/// A settled batch of changes made by another program. The flag is true when
/// one of them is part of the watched score, which should compile again.
pub type OnChange = Arc<dyn Fn(Vec<FileChange>, bool) + Send + Sync>;

#[derive(Default)]
struct State {
    /// What each watched file held when last seen; `None` while it is missing.
    known: HashMap<PathBuf, Option<String>>,
    /// Files the editor opened: canonical path → the path it used.
    opened: HashMap<PathBuf, PathBuf>,
    /// The watched score's files and missing includes, canonical.
    score_files: HashSet<PathBuf>,
    root: Option<PathBuf>,
    /// One non-recursive watch per directory: a watch on a file ends when an
    /// editor saves by renaming over it.
    directories: HashSet<PathBuf>,
    pending: Vec<PathBuf>,
    timer: Option<JoinHandle<()>>,
    disposed: bool,
}

struct Inner {
    state: Mutex<State>,
    watcher: Mutex<Option<RecommendedWatcher>>,
    events: Mutex<Option<JoinHandle<()>>>,
    on_change: OnChange,
    delay: Duration,
}

/// A cheap handle: clones share the watches.
#[derive(Clone)]
pub struct ScoreWatcher(Arc<Inner>);

impl ScoreWatcher {
    /// Reports changes once the files have been quiet for 150 ms. Must be
    /// called within a Tokio runtime.
    pub fn new(on_change: impl Fn(Vec<FileChange>, bool) + Send + Sync + 'static) -> Self {
        Self::with_delay(on_change, Duration::from_millis(150))
    }

    /// `new`, with how long the files must be quiet before a change is reported.
    pub fn with_delay(
        on_change: impl Fn(Vec<FileChange>, bool) + Send + Sync + 'static,
        delay: Duration,
    ) -> Self {
        let (sender, mut receiver) = mpsc::unbounded_channel::<notify::Result<notify::Event>>();
        let watcher = notify::recommended_watcher(move |event| {
            let _ = sender.send(event);
        })
        .ok();
        let this = Self(Arc::new(Inner {
            state: Mutex::default(),
            watcher: Mutex::new(watcher),
            events: Mutex::new(None),
            on_change: Arc::new(on_change),
            delay,
        }));
        let weak = Arc::downgrade(&this.0);
        let events = tokio::spawn(async move {
            while let Some(event) = receiver.recv().await {
                let Some(inner) = weak.upgrade() else { return };
                ScoreWatcher(inner).event(event);
            }
        });
        *this.0.events.lock().unwrap_or_else(|p| p.into_inner()) = Some(events);
        this
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.0
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The score whose files are watched.
    pub fn score(&self) -> Option<PathBuf> {
        self.state().root.clone()
    }

    /// A file the editor opened, with the text it shows; watched from now on.
    pub async fn open(&self, file: &Path, text: &str) {
        let real = canonical(file).await;
        {
            let mut state = self.state();
            state.opened.insert(real.clone(), file.to_path_buf());
            state.known.insert(real, Some(text.to_owned()));
        }
        self.sync();
    }

    /// Call before the studio writes `text` to `file`, so the write is not taken for a change.
    pub async fn writing(&self, file: &Path, text: &str) {
        let real = canonical(file).await;
        let mut state = self.state();
        if let Some(known) = state.known.get_mut(&real) {
            *known = Some(text.to_owned());
        }
    }

    /// Watches `root_file` and its includes in place of the previous score.
    /// Called after each compile, as an edit may have added or removed an include.
    pub async fn watch_score(&self, root_file: &Path) {
        let graph = include_graph(root_file, &IncludeOptions::default()).await;
        let next: HashSet<PathBuf> = graph.files.into_iter().chain(graph.missing).collect();
        // What a file held before is kept: a change made during the compile still counts.
        let unknown: Vec<PathBuf> = {
            let state = self.state();
            next.iter()
                .filter(|file| !state.known.contains_key(*file))
                .cloned()
                .collect()
        };
        for file in unknown {
            let text = read(&file).await;
            self.state().known.entry(file).or_insert(text);
        }
        {
            let mut state = self.state();
            if state.disposed {
                return;
            }
            state.root = Some(paths::resolve(root_file));
            state.score_files = next;
        }
        self.sync();
    }

    pub fn dispose(&self) {
        {
            let mut state = self.state();
            state.disposed = true;
            if let Some(timer) = state.timer.take() {
                timer.abort();
            }
            state.directories.clear();
        }
        self.0
            .watcher
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take();
        if let Some(events) = self
            .0
            .events
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take()
        {
            events.abort();
        }
    }

    /// Forgets files no longer watched and watches the directories of the rest.
    fn sync(&self) {
        let mut state = self.state();
        if state.disposed {
            return;
        }
        let State {
            known,
            opened,
            score_files,
            ..
        } = &mut *state;
        known.retain(|file, _| opened.contains_key(file) || score_files.contains(file));
        let wanted: HashSet<PathBuf> = state.known.keys().map(paths::dirname).collect();
        let mut watcher = self.0.watcher.lock().unwrap_or_else(|p| p.into_inner());
        let Some(watcher) = watcher.as_mut() else {
            return;
        };
        let gone: Vec<PathBuf> = state.directories.difference(&wanted).cloned().collect();
        for dir in gone {
            let _ = watcher.unwatch(&dir);
            state.directories.remove(&dir);
        }
        for dir in wanted {
            if state.directories.contains(&dir) {
                continue;
            }
            // A missing directory: an include there can only appear with it, which is not watched.
            if watcher.watch(&dir, RecursiveMode::NonRecursive).is_ok() {
                state.directories.insert(dir);
            }
        }
    }

    fn event(&self, event: notify::Result<notify::Event>) {
        match event {
            Ok(event) => {
                if matches!(event.kind, EventKind::Access(_)) {
                    return;
                }
                if event.paths.is_empty() || event.need_rescan() {
                    let dirs: Vec<PathBuf> = self.state().directories.iter().cloned().collect();
                    for dir in dirs {
                        self.touched(&dir, None);
                    }
                }
                for path in &event.paths {
                    self.touched(&paths::dirname(path), Some(path.clone()));
                }
            }
            // A directory that goes away ends its watch; its files read as missing.
            Err(error) => {
                let mut state = self.state();
                let mut watcher = self.0.watcher.lock().unwrap_or_else(|p| p.into_inner());
                for path in &error.paths {
                    if state.directories.remove(path)
                        && let Some(watcher) = watcher.as_mut()
                    {
                        let _ = watcher.unwatch(path);
                    }
                }
            }
        }
    }

    fn touched(&self, dir: &Path, file: Option<PathBuf>) {
        let mut state = self.state();
        if state.disposed {
            return;
        }
        let files: Vec<PathBuf> = match file {
            Some(file) => vec![file],
            None => state
                .known
                .keys()
                .filter(|f| paths::dirname(f) == dir)
                .cloned()
                .collect(),
        };
        let watched: Vec<PathBuf> = files
            .into_iter()
            .filter(|f| state.known.contains_key(f))
            .collect();
        if watched.is_empty() {
            return;
        }
        for file in watched {
            if !state.pending.contains(&file) {
                state.pending.push(file);
            }
        }
        if let Some(timer) = state.timer.take() {
            timer.abort();
        }
        let this = self.clone();
        let delay = self.0.delay;
        state.timer = Some(tokio::spawn(async move {
            tokio::time::sleep(delay).await;
            tokio::spawn(async move { this.flush().await });
        }));
    }

    async fn flush(&self) {
        let files = std::mem::take(&mut self.state().pending);
        let mut changes = Vec::new();
        let mut score = false;
        for file in files {
            if !self.state().known.contains_key(&file) {
                continue;
            }
            let text = read(&file).await;
            let mut state = self.state();
            if state.disposed {
                return;
            }
            if state.known.get(&file) == Some(&text) {
                continue;
            }
            let exists = text.is_some();
            state.known.insert(file.clone(), text);
            changes.push(FileChange {
                file: state
                    .opened
                    .get(&file)
                    .cloned()
                    .unwrap_or_else(|| file.clone()),
                exists,
            });
            if state.score_files.contains(&file) {
                score = true;
            }
        }
        if !changes.is_empty() {
            (self.0.on_change)(changes, score);
        }
    }
}

async fn read(file: &Path) -> Option<String> {
    tokio::fs::read_to_string(file).await.ok()
}

/// The real path, as the include graph names files; the resolved path of a missing one.
async fn canonical(file: &Path) -> PathBuf {
    match tokio::fs::canonicalize(file).await {
        Ok(real) => real,
        Err(_) => paths::resolve(file),
    }
}
