//! The users' workers (DECISIONS D55): one process per signed-in user,
//! started when their page connects and stopped when no page has been
//! connected for a while. A worker serves one page at a time, as the app has
//! one window: a page opened in a second tab takes it over, and the first
//! is told so. The gateway passes lines both ways and reads none of them.
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::json;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot};

use crate::sandbox::{Sandbox, WorkerPlan};
use crate::users::{User, random_hex, user_dir};

/// What goes to a page: a line, or the end with a last line.
pub enum ToPage {
    Line(String),
    End(String),
}

/// How long a worker has to stop lilypond and exit once its stdin ends.
const STOP_GRACE: Duration = Duration::from_secs(5);

pub struct Workers {
    sandbox: Sandbox,
    exe: PathBuf,
    data: PathBuf,
    runtime: PathBuf,
    lilypond: Option<PathBuf>,
    binds: Vec<PathBuf>,
    idle: Duration,
    max: usize,
    running: Mutex<HashMap<String, Arc<Worker>>>,
    /// Held while a worker is looked up or started, so two pages of a user start one.
    starting: tokio::sync::Mutex<()>,
    next_page: AtomicU64,
}

pub struct Worker {
    user: String,
    /// A new one each start: the page replays its state to a worker it has not seen (D55).
    pub instance: String,
    stdin: Mutex<Option<mpsc::UnboundedSender<String>>>,
    page: Mutex<Option<Page>>,
    /// Since when no page is connected.
    idle_since: Mutex<Option<Instant>>,
    stop: Mutex<Option<oneshot::Sender<()>>>,
}

struct Page {
    id: u64,
    out: mpsc::UnboundedSender<ToPage>,
}

/// A page connected to its user's worker.
pub struct Connection {
    pub worker: Arc<Worker>,
    pub page: u64,
    pub out: mpsc::UnboundedReceiver<ToPage>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub struct WorkersOptions {
    pub sandbox: Sandbox,
    pub exe: PathBuf,
    pub data: PathBuf,
    pub runtime: PathBuf,
    pub lilypond: Option<PathBuf>,
    pub binds: Vec<PathBuf>,
    pub idle: Duration,
    pub max: usize,
}

impl Workers {
    pub fn new(options: WorkersOptions) -> Arc<Workers> {
        let workers = Arc::new(Workers {
            sandbox: options.sandbox,
            exe: options.exe,
            data: options.data,
            runtime: options.runtime,
            lilypond: options.lilypond,
            binds: options.binds,
            idle: options.idle,
            max: options.max,
            running: Mutex::new(HashMap::new()),
            starting: tokio::sync::Mutex::new(()),
            next_page: AtomicU64::new(1),
        });
        // Stops the workers no page has used for `idle`.
        let weak = Arc::downgrade(&workers);
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(30));
            loop {
                tick.tick().await;
                let Some(workers) = weak.upgrade() else {
                    return;
                };
                workers.stop_idle(workers.idle);
            }
        });
        workers
    }

    /// Stops and forgets the workers idle for at least `idle`; returns how many.
    fn stop_idle(&self, idle: Duration) -> usize {
        let mut running = lock(&self.running);
        let idle_ones: Vec<String> = running
            .iter()
            .filter(|(_, worker)| worker.idle_for().is_some_and(|since| since >= idle))
            .map(|(id, _)| id.clone())
            .collect();
        for id in &idle_ones {
            if let Some(worker) = running.remove(id) {
                worker.shut_down();
            }
        }
        idle_ones.len()
    }

    /// Connects a page of `user` to their worker, starting it when it is not
    /// running. A page connected before is told it was replaced.
    pub async fn connect(self: &Arc<Self>, user: &User) -> Result<Connection, String> {
        let worker = {
            let _starting = self.starting.lock().await;
            let running = lock(&self.running).get(&user.id).cloned();
            match running {
                Some(worker) => worker,
                None => self.start(user).await?,
            }
        };
        let page = self.next_page.fetch_add(1, Ordering::Relaxed);
        let (out, receiver) = mpsc::unbounded_channel();
        let previous = lock(&worker.page).replace(Page { id: page, out });
        *lock(&worker.idle_since) = None;
        if let Some(previous) = previous {
            let _ = previous
                .out
                .send(ToPage::End(json!({ "replaced": true }).to_string()));
        }
        Ok(Connection {
            worker,
            page,
            out: receiver,
        })
    }

    /// The page `page` went away; the worker idles until another connects.
    pub fn disconnect(&self, worker: &Worker, page: u64) {
        let mut current = lock(&worker.page);
        if current.as_ref().is_some_and(|p| p.id == page) {
            *current = None;
            *lock(&worker.idle_since) = Some(Instant::now());
        }
    }

    async fn start(self: &Arc<Self>, user: &User) -> Result<Arc<Worker>, String> {
        {
            let mut running = lock(&self.running);
            if let Some(worker) = running.get(&user.id) {
                return Ok(worker.clone());
            }
            // Room is made by stopping the longest idle worker.
            if running.len() >= self.max {
                let oldest = running
                    .iter()
                    .filter_map(|(id, worker)| worker.idle_for().map(|idle| (id.clone(), idle)))
                    .max_by_key(|(_, idle)| *idle)
                    .map(|(id, _)| id);
                match oldest.and_then(|id| running.remove(&id)) {
                    Some(worker) => worker.shut_down(),
                    None => {
                        return Err(
                            "The server is busy: too many people are using it. Try again in a few minutes."
                                .into(),
                        );
                    }
                }
            }
        }
        let dir = user_dir(&self.data, &user.id);
        for sub in ["scores", "studio"] {
            create_private_dir(&dir.join(sub)).await?;
        }
        let plan = WorkerPlan {
            exe: self.exe.clone(),
            data: self.data.clone(),
            user_dir: dir,
            runtime: self.runtime.clone(),
            lilypond: self.lilypond.clone(),
            binds: self.binds.clone(),
        };
        let mut child = self
            .sandbox
            .command(&plan)
            .spawn()
            .map_err(|error| format!("Your studio could not start: {error}"))?;
        let (Some(mut stdin), Some(stdout), Some(stderr)) =
            (child.stdin.take(), child.stdout.take(), child.stderr.take())
        else {
            return Err("Your studio could not start: no pipes.".into());
        };

        let (lines, mut to_stdin) = mpsc::unbounded_channel::<String>();
        let (stop, stopped) = oneshot::channel();
        let worker = Arc::new(Worker {
            user: user.name.clone(),
            instance: random_hex(8),
            stdin: Mutex::new(Some(lines)),
            page: Mutex::new(None),
            idle_since: Mutex::new(Some(Instant::now())),
            stop: Mutex::new(Some(stop)),
        });

        tokio::spawn(async move {
            while let Some(line) = to_stdin.recv().await {
                if stdin.write_all(line.as_bytes()).await.is_err()
                    || stdin.write_all(b"\n").await.is_err()
                {
                    break;
                }
            }
            // Dropped here: the worker reads the end of stdin and exits.
        });
        tokio::spawn({
            let name = user.name.clone();
            async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    eprintln!("[{name}] {line}");
                }
            }
        });
        tokio::spawn({
            let worker = worker.clone();
            let workers = Arc::downgrade(self);
            let user_id = user.id.clone();
            async move {
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let page = lock(&worker.page);
                    if let Some(page) = page.as_ref() {
                        let _ = page.out.send(ToPage::Line(line));
                    }
                }
                // The worker ended: forgotten, and its page told.
                if let Some(workers) = workers.upgrade() {
                    let mut running = lock(&workers.running);
                    if running
                        .get(&user_id)
                        .is_some_and(|running| Arc::ptr_eq(running, &worker))
                    {
                        running.remove(&user_id);
                    }
                }
                if let Some(page) = lock(&worker.page).take() {
                    let _ = page.out.send(ToPage::End(
                        json!({ "closed": "Your studio stopped. Reload the page to start it again." })
                            .to_string(),
                    ));
                }
            }
        });
        tokio::spawn({
            let name = user.name.clone();
            async move {
                let status = tokio::select! {
                    status = child.wait() => status,
                    _ = stopped => match tokio::time::timeout(STOP_GRACE, child.wait()).await {
                        Ok(status) => status,
                        Err(_) => {
                            let _ = child.kill().await;
                            child.wait().await
                        }
                    },
                };
                match status {
                    Ok(status) if status.success() => {}
                    Ok(status) => eprintln!("[{name}] the worker ended: {status}"),
                    Err(error) => eprintln!("[{name}] the worker ended: {error}"),
                }
            }
        });

        lock(&self.running).insert(user.id.clone(), worker.clone());
        eprintln!("[{}] started a worker", user.name);
        Ok(worker)
    }

    /// Stops every worker, as the server shuts down.
    pub fn shut_down_all(&self) {
        for (_, worker) in lock(&self.running).drain() {
            worker.shut_down();
        }
    }
}

impl Worker {
    /// Passes a line of the page to the worker.
    pub fn send(&self, line: String) {
        if let Some(stdin) = lock(&self.stdin).as_ref() {
            let _ = stdin.send(line);
        }
    }

    fn idle_for(&self) -> Option<Duration> {
        lock(&self.idle_since).map(|since| since.elapsed())
    }

    /// Ends its stdin, so it stops lilypond and exits; killed if it does not.
    fn shut_down(&self) {
        eprintln!("[{}] stopping the worker", self.user);
        lock(&self.stdin).take();
        if let Some(stop) = lock(&self.stop).take() {
            let _ = stop.send(());
        }
        if let Some(page) = lock(&self.page).take() {
            let _ = page.out.send(ToPage::End(
                json!({ "closed": "Your studio was stopped. Reload the page to start it again." })
                    .to_string(),
            ));
        }
    }
}

async fn create_private_dir(dir: &std::path::Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    tokio::fs::create_dir_all(dir)
        .await
        .map_err(|error| format!("{}: {error}", dir.display()))?;
    if let Some(parent) = dir.parent() {
        let _ = tokio::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700)).await;
    }
    Ok(())
}
