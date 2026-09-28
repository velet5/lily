//! Live preview for Lily Studio (DECISIONS D36): the texts of the files with unsaved edits,
//! as the renderer reports them, and the timer that turns a burst of typing
//! into one compile of the score they belong to.
//!
//! The texts live in `LiveTexts`, which is made first and handed to both
//! sides: `StudioCompiler` reads them through `LiveTexts::reader` when a
//! compile starts, and `LiveCompile` writes them and asks that compiler for
//! compiles. Neither needs the other to exist first.

use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use futures::future::{BoxFuture, join_all};
use tokio::task::JoinHandle;

use crate::compile_service::{Buffers, CompileOutcome};
use crate::paths;
use crate::root_file::SourceBuffers;

/// What `LiveCompile` needs of `StudioCompiler`; tests pass a stand-in.
pub trait LiveTarget: Send + Sync + 'static {
    fn current(&self) -> Option<PathBuf>;
    fn root_for(&self, file: PathBuf) -> BoxFuture<'static, Option<PathBuf>>;
    /// Queues a compile of `root` at the call.
    fn compile(&self, root: PathBuf) -> BoxFuture<'static, Option<CompileOutcome>>;
}

#[derive(Debug)]
struct Texts {
    /// Unsaved text by absolute path, in the order first edited; kept while
    /// live preview is off, too.
    texts: Vec<(PathBuf, String)>,
    enabled: bool,
}

/// The unsaved texts and whether live preview is on. Clones share them.
#[derive(Debug, Clone)]
pub struct LiveTexts(Arc<Mutex<Texts>>);

impl Default for LiveTexts {
    fn default() -> Self {
        Self::new(true)
    }
}

impl LiveTexts {
    pub fn new(enabled: bool) -> Self {
        Self(Arc::new(Mutex::new(Texts {
            texts: Vec::new(),
            enabled,
        })))
    }

    fn lock(&self) -> MutexGuard<'_, Texts> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// What compiles read instead of the files on disk: the unsaved texts
    /// while live preview is on, none while it is off. A copy, so a compile
    /// keeps the texts it started with.
    pub fn buffers(&self) -> SourceBuffers {
        let texts = self.lock();
        if texts.enabled {
            texts.texts.iter().cloned().collect()
        } else {
            SourceBuffers::new()
        }
    }

    /// `buffers`, as `StudioCompilerOptions::buffers` takes it.
    pub fn reader(&self) -> Buffers {
        let texts = self.clone();
        Arc::new(move || texts.buffers())
    }

    pub fn enabled(&self) -> bool {
        self.lock().enabled
    }

    fn files(&self) -> Vec<PathBuf> {
        self.lock()
            .texts
            .iter()
            .map(|(file, _)| file.clone())
            .collect()
    }
}

#[derive(Debug, Clone, Copy)]
pub struct LiveOptions {
    /// Quiet time after the last edit before compiling; the extension's 150 ms (D25).
    pub delay: Duration,
    /// Longest wait from the first edit of a burst; the extension's 750 ms (D25).
    pub max_wait: Duration,
}

impl Default for LiveOptions {
    fn default() -> Self {
        Self {
            delay: Duration::from_millis(150),
            max_wait: Duration::from_millis(750),
        }
    }
}

#[derive(Default)]
struct Timers {
    /// Files edited since the last compile was scheduled, in order.
    edits: Vec<PathBuf>,
    timer: Option<JoinHandle<()>>,
    deadline: Option<JoinHandle<()>>,
}

struct Inner {
    target: Arc<dyn LiveTarget>,
    texts: LiveTexts,
    delay: Duration,
    max_wait: Duration,
    timers: Mutex<Timers>,
}

/// Turns edits into compiles. A cheap handle: clones share the state.
#[derive(Clone)]
pub struct LiveCompile(Arc<Inner>);

impl LiveCompile {
    /// Must be called within a Tokio runtime. Live preview starts as `texts` says.
    pub fn new(target: Arc<dyn LiveTarget>, texts: LiveTexts, options: LiveOptions) -> Self {
        Self(Arc::new(Inner {
            target,
            texts,
            delay: options.delay,
            max_wait: options.max_wait.max(options.delay),
            timers: Mutex::default(),
        }))
    }

    fn timers(&self) -> MutexGuard<'_, Timers> {
        self.0
            .timers
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn enabled(&self) -> bool {
        self.0.texts.enabled()
    }

    /// See `LiveTexts::buffers`.
    pub fn buffers(&self) -> SourceBuffers {
        self.0.texts.buffers()
    }

    /// The shared texts.
    pub fn texts(&self) -> &LiveTexts {
        &self.0.texts
    }

    /// `file` now has the unsaved text `text`, or none: it was saved or
    /// reloaded, which compile by themselves (D31, D34).
    pub fn edited(&self, file: impl Into<PathBuf>, text: Option<String>) {
        let file = paths::resolve(file.into());
        let Some(text) = text else {
            self.0.texts.lock().texts.retain(|(f, _)| *f != file);
            self.timers().edits.retain(|f| *f != file);
            return;
        };
        {
            let mut texts = self.0.texts.lock();
            match texts.texts.iter_mut().find(|(f, _)| *f == file) {
                Some((_, current)) if *current == text => return,
                Some((_, current)) => *current = text,
                None => texts.texts.push((file.clone(), text)),
            }
            if !texts.enabled {
                return;
            }
        }
        let mut timers = self.timers();
        if !timers.edits.contains(&file) {
            timers.edits.push(file);
        }
        self.schedule(&mut timers);
    }

    /// On: compiles what the unsaved files belong to. Off: drops what was
    /// waiting and compiles the score shown last from disk, so the preview
    /// shows the saved files again.
    pub fn set_enabled(&self, enabled: bool) {
        {
            let mut texts = self.0.texts.lock();
            if texts.enabled == enabled {
                return;
            }
            texts.enabled = enabled;
        }
        let files = self.0.texts.files();
        if enabled {
            if files.is_empty() {
                return;
            }
            {
                let mut timers = self.timers();
                for file in files {
                    if !timers.edits.contains(&file) {
                        timers.edits.push(file);
                    }
                }
            }
            tokio::spawn(self.clone().flush());
            return;
        }
        {
            let mut timers = self.timers();
            clear_timers(&mut timers);
            timers.edits.clear();
        }
        if let Some(current) = self.0.target.current()
            && !files.is_empty()
        {
            tokio::spawn(self.0.target.compile(current));
        }
    }

    pub fn dispose(&self) {
        let mut timers = self.timers();
        clear_timers(&mut timers);
        timers.edits.clear();
    }

    fn schedule(&self, timers: &mut Timers) {
        if let Some(timer) = timers.timer.take() {
            timer.abort();
        }
        timers.timer = Some(self.after(self.0.delay));
        if timers.deadline.is_none() {
            timers.deadline = Some(self.after(self.0.max_wait));
        }
    }

    /// A flush after `delay`. The flush runs as a task of its own, so that
    /// clearing the timers does not abort it.
    fn after(&self, delay: Duration) -> JoinHandle<()> {
        let this = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(delay).await;
            tokio::spawn(this.flush());
        })
    }

    /// Compiles each score an edited file belongs to, once. Resolves once they are queued.
    async fn flush(self) {
        let files = {
            let mut timers = self.timers();
            clear_timers(&mut timers);
            std::mem::take(&mut timers.edits)
        };
        // An include no score reaches compiles nothing; unlike a save, it is
        // not reported on every keystroke.
        let roots = join_all(files.into_iter().map(|file| self.0.target.root_for(file))).await;
        if !self.enabled() {
            return;
        }
        let mut compiled: Vec<PathBuf> = Vec::new();
        for root in roots.into_iter().flatten() {
            if compiled.contains(&root) {
                continue;
            }
            compiled.push(root.clone());
            tokio::spawn(self.0.target.compile(root));
        }
    }
}

fn clear_timers(timers: &mut Timers) {
    for timer in [timers.timer.take(), timers.deadline.take()]
        .into_iter()
        .flatten()
    {
        timer.abort();
    }
}
