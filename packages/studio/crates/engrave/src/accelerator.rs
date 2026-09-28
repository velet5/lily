//! The acceleration helpers of the preview compile (DECISIONS D25), from
//! src/compile/accelerator.ts: the glyph cache, and a warm lilypond parent
//! that forks one child per request and answers over a private fd 3.

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::os::fd::{FromRawFd, OwnedFd};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use futures::FutureExt;
use futures::future::{BoxFuture, Shared};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{ChildStdin, Command};
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

use crate::search_path::SearchPath;

// Only this exact upstream backend has been checked. Unknown/patched versions
// use ordinary spawning; installed LilyPond files are never changed.
pub const BACKEND_HASH: &str = "82b4a568e196239557fba92670dc0d9a685edae129dc0625fc1f1ef65a70e6d2";
const PROBE: &str = "(begin (display (lilypond-version)) (newline) (display (search-path %load-path \"lily/output-svg.scm\")) (newline) (primitive-exit 0))";

/// Requests a warm parent serves before it is replaced.
const MAX_REQUESTS: u32 = 32;
/// Age at which a warm parent is replaced.
const MAX_AGE: Duration = Duration::from_secs(5 * 60);
/// Idle time after which a warm parent stops.
const IDLE: Duration = Duration::from_secs(60);
/// How long a parent has to say READY.
const STARTUP: Duration = Duration::from_secs(10);
/// At most this many parents are kept.
const MAX_WORKERS: usize = 4;

/// A Scheme string literal of `value`.
pub fn scheme_string(value: &str) -> String {
    let escaped = value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
        .replace('\r', "\\r");
    format!("\"{escaped}\"")
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProcessResult {
    /// `None` when the process was killed by a signal.
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

type Ready = Shared<BoxFuture<'static, Result<String, String>>>;

struct Pending {
    answer: oneshot::Sender<Result<String, String>>,
    timer: JoinHandle<()>,
}

#[derive(Default)]
struct WarmState {
    answer: Option<Pending>,
    failure: Option<String>,
    requests: u32,
    idle: Option<JoinHandle<()>>,
    ready: Option<Ready>,
}

struct WarmInner {
    state: Mutex<WarmState>,
    stdin: tokio::sync::Mutex<Option<ChildStdin>>,
    /// The process group, which is the parent's pid.
    group: Option<i32>,
    born: Instant,
}

/// A parent owned by one root/configuration, with one private request at a
/// time. Clones are handles on the same process.
#[derive(Clone)]
pub struct WarmCompiler(Arc<WarmInner>);

impl WarmCompiler {
    /// Starts a parent: `binary` with `args`, loading `worker.scm` from
    /// `runtime_dir`, in its own process group, with the control pipe on fd 3.
    /// Must be called within a Tokio runtime.
    pub fn new(
        binary: &Path,
        args: &[String],
        cwd: &Path,
        runtime_dir: &Path,
        path: &str,
    ) -> WarmCompiler {
        match Self::spawn(binary, args, cwd, runtime_dir, path) {
            Ok(worker) => worker,
            Err(error) => {
                let worker = Self::with(None, None);
                worker.stop(error.to_string());
                worker.install_ready(Duration::ZERO);
                worker
            }
        }
    }

    fn with(stdin: Option<ChildStdin>, group: Option<i32>) -> WarmCompiler {
        WarmCompiler(Arc::new(WarmInner {
            state: Mutex::new(WarmState::default()),
            stdin: tokio::sync::Mutex::new(stdin),
            group,
            born: Instant::now(),
        }))
    }

    fn spawn(
        binary: &Path,
        args: &[String],
        cwd: &Path,
        runtime_dir: &Path,
        path: &str,
    ) -> std::io::Result<WarmCompiler> {
        let (read, write) = control_pipe()?;
        let worker_scm = runtime_dir.join("worker.scm");
        let mut command = Command::new(binary);
        command
            .args(args)
            .arg("-e")
            .arg(format!(
                "(load {})",
                scheme_string(&worker_scm.to_string_lossy())
            ))
            .current_dir(cwd)
            .env("PATH", path)
            .env("LANGUAGE", "en")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .process_group(0);
        let write_fd = std::os::fd::AsRawFd::as_raw_fd(&write);
        // SAFETY: only async-signal-safe calls (dup2, fcntl) between fork and exec.
        unsafe {
            command.pre_exec(move || {
                if write_fd != 3 && libc::dup2(write_fd, 3) == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                // dup2 clears close-on-exec, but not when the pipe already was fd 3.
                if libc::fcntl(3, libc::F_SETFD, 0) == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut child = command.spawn()?;
        drop(write);
        let group = child.id().and_then(|pid| i32::try_from(pid).ok());
        let worker = Self::with(child.stdin.take(), group);
        worker.install_ready(STARTUP);

        // The control channel: one line per answer, read on a thread of its own.
        let control = worker.clone();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(std::fs::File::from(read));
            let mut line = Vec::new();
            loop {
                line.clear();
                match reader.read_until(b'\n', &mut line) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        let text = String::from_utf8_lossy(&line);
                        control.answered(text.trim_end_matches(['\n', '\r']));
                    }
                }
            }
        });

        // Parent output is never a score's output. Bound it; unexpected logging
        // is diagnostic context for fallback, not an unbounded retained buffer.
        let mut stderr = child.stderr.take();
        let exited = worker.clone();
        tokio::spawn(async move {
            let mut log: Vec<u8> = Vec::new();
            if let Some(stderr) = stderr.as_mut() {
                let mut chunk = [0u8; 4096];
                while let Ok(n) = stderr.read(&mut chunk).await {
                    if n == 0 {
                        break;
                    }
                    log.extend_from_slice(&chunk[..n]);
                    if log.len() > 8192 {
                        log.drain(..log.len() - 8192);
                    }
                }
            }
            let _ = child.wait().await;
            exited.stop(format!(
                "Warm compiler exited. {}",
                String::from_utf8_lossy(&log)
            ));
        });
        Ok(worker)
    }

    fn state(&self) -> MutexGuard<'_, WarmState> {
        self.0
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn install_ready(&self, timeout: Duration) {
        let ready = self.response(timeout);
        let ready: Ready = async move {
            match ready {
                Ok(receiver) => receiver
                    .await
                    .unwrap_or_else(|_| Err("Warm compiler stopped".to_owned())),
                Err(failure) => Err(failure),
            }
        }
        .boxed()
        .shared();
        self.state().ready = Some(ready);
    }

    /// A line on the control pipe.
    fn answered(&self, line: &str) {
        let mut state = self.state();
        if state.answer.is_none() || line.encode_utf16().count() > 100 {
            drop(state);
            return self.stop("Invalid warm compiler response".to_owned());
        }
        if let Some(pending) = state.answer.take() {
            pending.timer.abort();
            let _ = pending.answer.send(Ok(line.to_owned()));
        }
    }

    /// A request is waiting for its answer.
    pub fn busy(&self) -> bool {
        self.state().answer.is_some()
    }

    pub fn expired(&self) -> bool {
        let state = self.state();
        state.failure.is_some() || state.requests >= MAX_REQUESTS || self.0.born.elapsed() > MAX_AGE
    }

    /// Compiles `file` into `output_dir` in a forked child. Fails when the
    /// parent is unsupported, stopped, or does not answer within `timeout_ms`.
    pub async fn run(
        &self,
        file: &Path,
        output_dir: &Path,
        timeout_ms: u64,
    ) -> Result<ProcessResult, String> {
        let ready = {
            let mut state = self.state();
            if let Some(idle) = state.idle.take() {
                idle.abort();
            }
            state.ready.clone()
        };
        let ready = match ready {
            Some(ready) => ready.await?,
            None => return Err("Warm compiler stopped".to_owned()),
        };
        if ready != "READY" {
            return Err("Unsupported warm compiler".to_owned());
        }
        let id = {
            let mut state = self.state();
            state.requests += 1;
            state.requests
        };
        let response = self.response(Duration::from_millis(timeout_ms))?;
        let request = format!(
            "({id} {} {})\n",
            scheme_string(&file.to_string_lossy()),
            scheme_string(&output_dir.to_string_lossy())
        );
        {
            let mut stdin = self.0.stdin.lock().await;
            let written = match stdin.as_mut() {
                Some(stdin) => match stdin.write_all(request.as_bytes()).await {
                    Ok(()) => stdin.flush().await,
                    Err(error) => Err(error),
                },
                None => Err(std::io::Error::from(std::io::ErrorKind::BrokenPipe)),
            };
            if let Err(error) = written {
                self.stop(error.to_string());
            }
        }
        let answer = response
            .await
            .unwrap_or_else(|_| Err("Warm compiler stopped".to_owned()))?;
        let code = answer
            .strip_prefix(&format!("DONE {id} "))
            .filter(|code| *code == "0" || *code == "1")
            .ok_or_else(|| format!("Warm compiler failed: {answer}"))?;
        let exit_code: i32 = if code == "0" { 0 } else { 1 };
        let read = |name: &str| {
            let file = output_dir.join(name);
            async move {
                tokio::fs::read(&file)
                    .await
                    .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
                    .unwrap_or_default()
            }
        };
        let (stdout, stderr) = tokio::join!(read("worker.stdout"), read("worker.stderr"));
        let idle = self.clone();
        let timer = tokio::spawn(async move {
            tokio::time::sleep(IDLE).await;
            idle.stop("Warm compiler stopped".to_owned());
        });
        if let Some(previous) = self.state().idle.replace(timer) {
            previous.abort();
        }
        Ok(ProcessResult {
            exit_code: Some(exit_code),
            stdout,
            stderr,
        })
    }

    /// Kills the process group, including a stuck fork, and fails what waits.
    pub fn stop(&self, error: String) {
        let mut state = self.state();
        if state.failure.is_some() {
            return;
        }
        state.failure = Some(error.clone());
        if let Some(idle) = state.idle.take() {
            idle.abort();
        }
        if let Some(group) = self.0.group {
            // SAFETY: kill(2) with a negative pid signals that process group only.
            unsafe {
                libc::kill(-group, libc::SIGKILL);
            }
        }
        if let Some(pending) = state.answer.take() {
            pending.timer.abort();
            let _ = pending.answer.send(Err(error));
        }
    }

    fn response(
        &self,
        timeout: Duration,
    ) -> Result<oneshot::Receiver<Result<String, String>>, String> {
        let mut state = self.state();
        if let Some(failure) = &state.failure {
            return Err(failure.clone());
        }
        let (answer, receiver) = oneshot::channel();
        let expire = self.clone();
        let timer = tokio::spawn(async move {
            tokio::time::sleep(timeout).await;
            expire.stop("Warm compiler timed out".to_owned());
        });
        if let Some(previous) = state.answer.replace(Pending { answer, timer }) {
            previous.timer.abort();
        }
        Ok(receiver)
    }

    fn same(&self, other: &WarmCompiler) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}

/// A pipe whose ends are closed on exec; the child gets the write end as fd 3.
fn control_pipe() -> std::io::Result<(OwnedFd, OwnedFd)> {
    let mut fds = [0 as libc::c_int; 2];
    // SAFETY: `fds` has room for the two descriptors pipe(2) writes.
    if unsafe { libc::pipe(fds.as_mut_ptr()) } == -1 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: pipe(2) succeeded, so both descriptors are open and owned by nobody else.
    let (read, write) = unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) };
    for fd in fds {
        // SAFETY: `fd` is open; F_SETFD only changes its flags.
        if unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } == -1 {
            return Err(std::io::Error::last_os_error());
        }
    }
    Ok((read, write))
}

type Probe = Shared<BoxFuture<'static, Option<String>>>;

#[derive(Default)]
struct AcceleratorState {
    probes: HashMap<String, Probe>,
    /// In the order they were started: root, configuration key, parent.
    workers: Vec<(PathBuf, String, WarmCompiler)>,
    /// Configurations whose parent failed, oldest first.
    failed: Vec<String>,
}

/// The glyph cache and the warm parents of one compile service. Clones share them.
#[derive(Clone)]
pub struct Accelerator {
    runtime_dir: Option<PathBuf>,
    search_path: SearchPath,
    state: Arc<Mutex<AcceleratorState>>,
}

impl Accelerator {
    pub fn new(runtime_dir: Option<PathBuf>, search_path: SearchPath) -> Self {
        Self {
            runtime_dir,
            search_path,
            state: Arc::default(),
        }
    }

    fn state(&self) -> MutexGuard<'_, AcceleratorState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// What a probe and a parent depend on: the binary's real path, size and
    /// modification time, and the `PATH` it runs with (in place of the whole
    /// environment, which the process never changes).
    pub async fn identity(&self, binary: &Path) -> std::io::Result<String> {
        let real = tokio::fs::canonicalize(binary).await?;
        let stat = tokio::fs::metadata(&real).await?;
        let modified = stat
            .modified()
            .ok()
            .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(0.0, |d| d.as_secs_f64() * 1000.0);
        Ok(serde_json::json!([
            real.to_string_lossy(),
            stat.len(),
            modified,
            self.search_path.get()
        ])
        .to_string())
    }

    /// Whether `binary` is LilyPond 2.26.0 with the one SVG backend the cache
    /// was checked against. The backend's hash is checked on every call.
    pub async fn supported(&self, binary: &Path, identity: &str) -> bool {
        let Some(runtime_dir) = self.runtime_dir.clone() else {
            return false;
        };
        let probe = {
            let mut state = self.state();
            match state.probes.get(identity) {
                Some(probe) => probe.clone(),
                None => {
                    let probe = probe(binary.to_path_buf(), runtime_dir, self.search_path.get())
                        .boxed()
                        .shared();
                    state.probes.clear(); // bound retained binary identities
                    state.probes.insert(identity.to_owned(), probe.clone());
                    probe
                }
            }
        };
        let Some(backend) = probe.await else {
            return false;
        };
        match tokio::fs::read(&backend).await {
            Ok(bytes) => hex(&Sha256::digest(&bytes)) == BACKEND_HASH,
            Err(_) => false,
        }
    }

    pub fn cache_args(&self) -> Vec<String> {
        let dir = self.runtime_dir.clone().unwrap_or_default();
        vec![
            "-e".to_owned(),
            format!(
                "(load {})",
                scheme_string(&dir.join("glyph-cache.scm").to_string_lossy())
            ),
        ]
    }

    /// The parent for `root` in this configuration, started when there is
    /// none; `None` when the configuration failed before or every slot is busy.
    pub fn worker(
        &self,
        root: &Path,
        identity: &str,
        binary: &Path,
        args: &[String],
    ) -> Option<WarmCompiler> {
        let key = serde_json::json!([identity, args]).to_string();
        let mut state = self.state();
        if state.failed.contains(&key) {
            return None;
        }
        if let Some(index) = state.workers.iter().position(|(r, _, _)| r == root) {
            let (_, existing_key, worker) = &state.workers[index];
            if *existing_key == key && !worker.expired() {
                return Some(worker.clone());
            }
            worker.stop("Warm compiler stopped".to_owned());
            state.workers.remove(index);
        }
        // Bound idle processes even when many previews are opened.
        if state.workers.len() >= MAX_WORKERS {
            let idle = state
                .workers
                .iter()
                .position(|(_, _, worker)| !worker.busy())?;
            let (_, _, worker) = state.workers.remove(idle);
            worker.stop("Warm compiler stopped".to_owned());
        }
        let runtime_dir = self.runtime_dir.clone().unwrap_or_default();
        let worker = WarmCompiler::new(
            binary,
            args,
            &crate::paths::dirname(root),
            &runtime_dir,
            &self.search_path.get(),
        );
        state
            .workers
            .push((root.to_path_buf(), key, worker.clone()));
        Some(worker)
    }

    /// `worker` failed: its configuration is not tried again for a while.
    pub fn failed_worker(&self, root: &Path, worker: &WarmCompiler) {
        {
            let mut state = self.state();
            let Some(index) = state
                .workers
                .iter()
                .position(|(r, _, w)| r == root && w.same(worker))
            else {
                return;
            };
            let key = state.workers[index].1.clone();
            if !state.failed.contains(&key) {
                state.failed.push(key);
            }
            if state.failed.len() > 16 {
                state.failed.remove(0);
            }
        }
        self.release(root, None);
    }

    /// Stops the parent of `root`, when it is `expected` or none is given.
    pub fn release(&self, root: &Path, expected: Option<&WarmCompiler>) {
        let mut state = self.state();
        let Some(index) = state.workers.iter().position(|(r, _, _)| r == root) else {
            return;
        };
        if expected.is_some_and(|expected| !state.workers[index].2.same(expected)) {
            return;
        }
        let (_, _, worker) = state.workers.remove(index);
        worker.stop("Warm compiler stopped".to_owned());
    }

    pub fn dispose(&self) {
        let workers = std::mem::take(&mut self.state().workers);
        for (_, _, worker) in workers {
            worker.stop("Warm compiler stopped".to_owned());
        }
    }
}

/// Asks `binary` for its version and SVG backend; the backend when it is
/// 2.26.0 and the runtime has the glyph cache.
async fn probe(binary: PathBuf, runtime_dir: PathBuf, path: String) -> Option<String> {
    let mut command = Command::new(&binary);
    command
        .args(["--loglevel=ERROR", "-e", PROBE])
        .env("PATH", path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(5), command.output())
        .await
        .ok()?
        .ok()?;
    if !output.status.success() || output.stdout.len() > 16384 || output.stderr.len() > 16384 {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut lines = crate::span::js_trim(&stdout)
        .split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l));
    let version = lines.next();
    let backend = lines.next();
    tokio::fs::metadata(runtime_dir.join("glyph-cache.scm"))
        .await
        .ok()?;
    if version == Some("2.26.0") {
        backend.map(str::to_owned)
    } else {
        None
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
