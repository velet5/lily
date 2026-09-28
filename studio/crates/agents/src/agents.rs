//! Coding agents in the sidebar (DECISIONS D40): Claude Code and Codex, as the
//! user installed them, run headless in the open folder, one process per turn.
//! This module finds them, builds their arguments and reads their JSONL into
//! chat entries. No Tauri here, so the tests run it with plain `cargo test`;
//! the app adds the dialogs, the chat store and the IPC.

use std::collections::{HashMap, HashSet};
use std::ffi::CString;
use std::future::Future;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::{OnceCell, watch};

use crate::js;

/// An agent's environment: variable names and values.
pub type Env = HashMap<String, String>;

/// A boxed future, as the injected callbacks return them.
pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send + 'static>>;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentId {
    Claude,
    Codex,
}

impl AgentId {
    /// `"claude"` or `"codex"`; anything else is not an agent.
    pub fn parse(value: &str) -> Option<AgentId> {
        AGENTS
            .iter()
            .find(|agent| agent.id.as_str() == value)
            .map(|agent| agent.id)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            AgentId::Claude => "claude",
            AgentId::Codex => "codex",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Agent {
    pub id: AgentId,
    pub label: &'static str,
    pub command: &'static str,
    pub sign_in: &'static str,
}

pub const AGENTS: [Agent; 2] = [
    Agent {
        id: AgentId::Claude,
        label: "Claude Code",
        command: "claude",
        sign_in: "claude",
    },
    Agent {
        id: AgentId::Codex,
        label: "Codex",
        command: "codex",
        sign_in: "codex login",
    },
];

pub fn is_agent_id(value: &str) -> bool {
    AgentId::parse(value).is_some()
}

pub fn agent(id: AgentId) -> &'static Agent {
    match id {
        AgentId::Claude => &AGENTS[0],
        AgentId::Codex => &AGENTS[1],
    }
}

pub fn agent_label(id: AgentId) -> &'static str {
    agent(id).label
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentState {
    Ready,
    Missing,
    /// Found, but `--version` failed.
    Broken,
}

/// What the setup says about one agent.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
    pub id: AgentId,
    pub state: AgentState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// The path chosen in the setup, when there is one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chosen: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub message: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    User,
    Agent,
    /// Something the agent did: read or edited a file, ran a command.
    Tool,
    Error,
}

impl Role {
    pub fn parse(value: &str) -> Option<Role> {
        match value {
            "user" => Some(Role::User),
            "agent" => Some(Role::Agent),
            "tool" => Some(Role::Tool),
            "error" => Some(Role::Error),
            _ => None,
        }
    }
}

/// One line of a chat, as the sidebar shows it and chats.json keeps it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatEntry {
    pub role: Role,
    pub text: String,
    /// The images pasted with a user's message, as the studio saved them.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<String>,
}

impl ChatEntry {
    pub fn new(role: Role, text: impl Into<String>) -> ChatEntry {
        ChatEntry {
            role,
            text: text.into(),
            images: Vec::new(),
        }
    }
}

/// What one line of an agent's JSONL means to the chat.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AgentEvent {
    Session(String),
    Entry(ChatEntry),
    /// The turn ended; `ok` is false when the agent reported a failure.
    Done {
        ok: bool,
    },
}

fn entry(role: Role, text: impl Into<String>) -> AgentEvent {
    AgentEvent::Entry(ChatEntry::new(role, text))
}

// ---------------------------------------------------------------------------
// Finding the agents

const PATH_MARKER: &str = "__LILY_STUDIO_PATH__";

static LOGIN_PATH: OnceCell<String> = OnceCell::const_new();

/// The PATH of the user's login shell. An app opened from the Finder gets only
/// `/usr/bin:/bin:/usr/sbin:/sbin`, but the agents are installed by npm, bun,
/// Homebrew or their own installers into directories the shell's profile adds,
/// and Codex from npm needs `node` from there too. Asked once; empty when the
/// shell does not answer within five seconds.
pub async fn login_shell_path() -> String {
    LOGIN_PATH.get_or_init(ask_login_shell).await.clone()
}

async fn ask_login_shell() -> String {
    let shell = std::env::var("SHELL")
        .ok()
        .filter(|shell| !shell.is_empty())
        .unwrap_or_else(|| "/bin/zsh".to_owned());
    let script = format!("printf '%s%s%s' {PATH_MARKER} \"$PATH\" {PATH_MARKER}");
    let Ok(mut child) = Command::new(shell)
        .args(["-ilc", &script])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
    else {
        return String::new();
    };
    let mut output = Vec::new();
    if let Some(stdout) = child.stdout.take() {
        read_until_deadline(stdout, &mut output, Duration::from_secs(5)).await;
    }
    let _ = child.start_kill();
    let output = String::from_utf8_lossy(&output);
    static MARKED: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(&format!("(?s){PATH_MARKER}(.*?){PATH_MARKER}")).expect("a valid pattern")
    });
    MARKED
        .captures(&output)
        .map(|found| found[1].to_owned())
        .unwrap_or_default()
}

/// Reads `reader` to its end or until `limit` has passed, whichever is first.
async fn read_until_deadline(
    mut reader: impl AsyncRead + Unpin,
    into: &mut Vec<u8>,
    limit: Duration,
) {
    let deadline = tokio::time::Instant::now() + limit;
    let mut chunk = [0u8; 4096];
    while let Ok(Ok(read)) = tokio::time::timeout_at(deadline, reader.read(&mut chunk)).await {
        if read == 0 {
            break;
        }
        into.extend_from_slice(&chunk[..read]);
    }
}

fn home_dir() -> String {
    std::env::var("HOME").unwrap_or_default()
}

/// Where the agents' installers put them when the shell's PATH does not say.
pub fn agent_dirs(home: &str) -> Vec<String> {
    let home = Path::new(home);
    let mut dirs: Vec<String> = [
        ".local/bin",
        ".claude/local",
        ".npm-global/bin",
        ".bun/bin",
        ".volta/bin",
    ]
    .iter()
    .map(|dir| home.join(dir).to_string_lossy().into_owned())
    .collect();
    dirs.extend(["/opt/homebrew/bin".to_owned(), "/usr/local/bin".to_owned()]);
    dirs
}

/// The PATH the agents run with: the login shell's, then the app's own, then
/// `agent_dirs()`. `home` is `$HOME` when not given.
pub fn agent_path(login: &str, current: Option<&str>, home: Option<&str>) -> String {
    let home = home.map(str::to_owned).unwrap_or_else(home_dir);
    let extra = agent_dirs(&home);
    let mut seen = HashSet::new();
    let dirs: Vec<&str> = login
        .split(':')
        .chain(current.unwrap_or("").split(':'))
        .chain(extra.iter().map(String::as_str))
        .filter(|dir| !dir.is_empty() && seen.insert(*dir))
        .collect();
    dirs.join(":")
}

/// The app's own environment. A variable whose name or value is not UTF-8 is
/// left out.
pub fn process_env() -> Env {
    std::env::vars_os()
        .filter_map(|(name, value)| Some((name.into_string().ok()?, value.into_string().ok()?)))
        .collect()
}

/// The environment of an agent run. The variables a parent Claude Code or
/// Electron sets are left out: they would make the agent think it is nested,
/// or make Electron's own binary act as Node.
pub fn agent_env(path_value: &str, env: &Env) -> Env {
    let mut result = env.clone();
    result.insert("PATH".to_owned(), path_value.to_owned());
    result.insert("NO_COLOR".to_owned(), "1".to_owned());
    for name in [
        "CLAUDECODE",
        "CLAUDE_CODE_ENTRYPOINT",
        "ELECTRON_RUN_AS_NODE",
        "ELECTRON_NO_ATTACH_CONSOLE",
    ] {
        result.remove(name);
    }
    result
}

async fn is_executable(file: &str) -> bool {
    match tokio::fs::metadata(file).await {
        Ok(metadata) if metadata.is_file() => {}
        _ => return false,
    }
    let Ok(name) = CString::new(Path::new(file).as_os_str().as_bytes()) else {
        return false;
    };
    // SAFETY: `name` is a valid NUL-terminated string that outlives the call.
    unsafe { libc::access(name.as_ptr(), libc::X_OK) == 0 }
}

/// The first executable `command` on `path_value`.
pub async fn which(command: &str, path_value: &str) -> Option<String> {
    for dir in path_value.split(':').filter(|dir| !dir.is_empty()) {
        let candidate = Path::new(dir).join(command).to_string_lossy().into_owned();
        if is_executable(&candidate).await {
            return Some(candidate);
        }
    }
    None
}

/// Runs `<binary> --version` and gives its output, or why it failed.
pub type VersionRunner = Arc<dyn Fn(String) -> BoxFuture<Result<String, String>> + Send + Sync>;

#[derive(Clone, Default)]
pub struct DetectAgentOptions {
    /// A path chosen in the setup; else the agent's command on `path_value`.
    pub configured_path: Option<String>,
    pub model: Option<String>,
    pub path_value: String,
    /// `agent_env(path_value, process_env())` when not given.
    pub env: Option<Env>,
    /// Runs `<binary> --version`; tests pass a stand-in.
    pub version: Option<VersionRunner>,
}

pub async fn detect_agent(id: AgentId, options: DetectAgentOptions) -> AgentStatus {
    let agent = agent(id);
    let chosen = options
        .configured_path
        .as_deref()
        .map(js::trim)
        .filter(|path| !path.is_empty())
        .map(str::to_owned);
    let model = options.model.clone().filter(|model| !model.is_empty());
    let status =
        |state, path: Option<String>, version: Option<String>, message: String| AgentStatus {
            id,
            state,
            path,
            version,
            chosen: chosen.clone(),
            model: model.clone(),
            message,
        };
    let binary = match &chosen {
        Some(chosen) => is_executable(chosen).await.then(|| chosen.clone()),
        None => which(agent.command, &options.path_value).await,
    };
    let Some(binary) = binary else {
        let message = match &chosen {
            Some(chosen) => format!(
                "{} could not be found at {chosen}. Choose it again.",
                agent.label
            ),
            None => format!(
                "{} is not installed, or Lily Studio cannot find it.",
                agent.label
            ),
        };
        return status(AgentState::Missing, None, None, message);
    };
    let output = match &options.version {
        Some(version) => version(binary.clone()).await,
        None => {
            let env = options
                .env
                .clone()
                .unwrap_or_else(|| agent_env(&options.path_value, &process_env()));
            run_version(&binary, &env).await
        }
    };
    let Ok(output) = output else {
        let message = format!(
            "{} was found at {binary}, but it did not start.",
            agent.label
        );
        return status(AgentState::Broken, Some(binary), None, message);
    };
    static VERSION: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"\d+\.\d+(?:\.\d+)?").expect("a valid pattern"));
    let version = VERSION.find(&output).map(|found| found.as_str().to_owned());
    let message = match &version {
        Some(version) => format!("{} {version} is ready.", agent.label),
        None => format!("{} is ready.", agent.label),
    };
    status(AgentState::Ready, Some(binary), version, message)
}

async fn run_version(binary: &str, env: &Env) -> Result<String, String> {
    let run = Command::new(binary)
        .arg("--version")
        .env_clear()
        .envs(env)
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .output();
    let output = tokio::time::timeout(Duration::from_secs(20), run)
        .await
        .map_err(|_| "timed out".to_owned())?
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(format!("{}", output.status));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

// ---------------------------------------------------------------------------
// Arguments

/// What an agent may do in a turn, chosen under the message box (D43).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Permission {
    /// Reads the folder and answers; edits nothing, runs nothing.
    Read,
    /// Edits the folder's files and runs LilyPond (D40).
    #[default]
    Edit,
    /// Anything the user could do in a terminal: no limits, no sandbox.
    Full,
}

impl Permission {
    /// `"read"`, `"edit"` or `"full"`; anything else is not a permission.
    pub fn parse(value: &str) -> Option<Permission> {
        match value {
            "read" => Some(Permission::Read),
            "edit" => Some(Permission::Edit),
            "full" => Some(Permission::Full),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct TurnOptions {
    /// The whole prompt of this turn, context included (see `turn_prompt`).
    pub prompt: String,
    /// The agent's own session to continue; `None` for a chat's first turn.
    pub session_id: Option<String>,
    pub model: Option<String>,
    /// The LilyPond executable the agent may run to check its edits.
    pub lilypond: Option<String>,
    pub permission: Permission,
    /// Images pasted with the message, saved as files (see `turn_prompt`).
    pub images: Vec<String>,
}

fn non_empty(value: &Option<String>) -> Option<&str> {
    value.as_deref().filter(|value| !value.is_empty())
}

/// The command line of one turn. Nothing asks for permission while the agent
/// works, as there is no one at a terminal to answer: `turn.permission` sets
/// the limits beforehand (D43).
///
/// `Edit`, as D40 has it. Claude Code: `--permission-mode acceptEdits` accepts
/// edits inside the folder; the allowed tools add LilyPond and nothing else
/// that runs commands. Codex: its `workspace-write` sandbox lets commands write
/// only in the folder and the temp directory, without network.
/// `Read`: Claude Code is allowed only the tools that read; Codex runs in its
/// `read-only` sandbox. `Full`: Claude Code bypasses its permissions, Codex
/// runs without a sandbox.
/// `codex exec resume` takes neither `--sandbox` nor `--cd`, so both are given
/// as config and working directory.
///
/// Pasted images: Codex attaches each with `--image`, which takes several
/// values, so `--` ends the options before the session and the prompt.
/// Claude Code is told where they are in the prompt and may read their
/// directory (`--add-dir`), whatever the permission.
pub fn agent_args(id: AgentId, turn: &TurnOptions) -> Vec<String> {
    let model = turn
        .model
        .as_deref()
        .map(js::trim)
        .filter(|model| !model.is_empty());
    let session = non_empty(&turn.session_id);
    let mut args: Vec<String> = Vec::new();
    let mut push = |values: &[&str]| args.extend(values.iter().map(|value| (*value).to_owned()));
    match id {
        AgentId::Claude => {
            push(&[
                "-p",
                &turn.prompt,
                "--output-format",
                "stream-json",
                "--verbose",
            ]);
            match turn.permission {
                Permission::Read => {
                    push(&["--permission-mode", "default", "--allowedTools"]);
                    push(&["Read", "Glob", "Grep", "LS", "TodoWrite"]);
                }
                Permission::Edit => {
                    push(&["--permission-mode", "acceptEdits", "--allowedTools"]);
                    push(&[
                        "Read",
                        "Edit",
                        "MultiEdit",
                        "Write",
                        "Glob",
                        "Grep",
                        "LS",
                        "TodoWrite",
                        "Bash(lilypond:*)",
                    ]);
                    if let Some(lilypond) = non_empty(&turn.lilypond) {
                        push(&[&format!("Bash({lilypond}:*)")]);
                    }
                }
                Permission::Full => push(&["--permission-mode", "bypassPermissions"]),
            }
            if let Some(session) = session {
                push(&["--resume", session]);
            }
            if let Some(model) = model {
                push(&["--model", model]);
            }
            let mut dirs: Vec<&str> = Vec::new();
            for image in &turn.images {
                let dir = Path::new(image).parent().and_then(Path::to_str);
                if let Some(dir) = dir.filter(|dir| !dirs.contains(dir)) {
                    dirs.push(dir);
                }
            }
            for dir in dirs {
                push(&["--add-dir", dir]);
            }
        }
        AgentId::Codex => {
            push(&["exec"]);
            if session.is_some() {
                push(&["resume"]);
            }
            push(&["--json", "--skip-git-repo-check"]);
            let sandbox = match turn.permission {
                Permission::Read => "sandbox_mode=\"read-only\"",
                Permission::Edit => "sandbox_mode=\"workspace-write\"",
                Permission::Full => "sandbox_mode=\"danger-full-access\"",
            };
            push(&["-c", sandbox, "-c", "approval_policy=\"never\""]);
            if let Some(model) = model {
                push(&["-m", model]);
            }
            for image in &turn.images {
                push(&["--image", image]);
            }
            if !turn.images.is_empty() {
                push(&["--"]);
            }
            if let Some(session) = session {
                push(&[session]);
            }
            push(&[&turn.prompt]);
        }
    }
    args
}

/// Lines selected in the editor, 1-based, and their text.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Selection {
    pub start_line: i64,
    pub end_line: i64,
    pub text: String,
}

#[derive(Clone, Debug, Default)]
pub struct PromptContext {
    /// The open folder, where the agent runs.
    pub folder: String,
    /// The file in the editor.
    pub file: Option<String>,
    pub selection: Option<Selection>,
    pub lilypond: Option<String>,
    /// The first turn of a chat carries the instructions; the agent keeps them.
    pub first: bool,
    /// The turn may not change files (`Permission::Read`); the agent is told so.
    pub read_only: bool,
    /// Images pasted with the message, as files.
    pub images: Vec<String>,
}

/// Where an agent's check compiles write: in the temp directory, never next to
/// the sources. The studio creates it before each turn, as an agent may not run
/// `mkdir` (see `agent_args`).
pub fn agent_out_dir() -> PathBuf {
    std::env::temp_dir().join("lily-studio-agent")
}

/// The instructions of a chat's first turn: who the user is and how to check a score.
pub fn instructions(lilypond: Option<&str>) -> String {
    let lilypond = lilypond.unwrap_or("lilypond");
    let out_dir = agent_out_dir();
    let out_dir = out_dir.to_string_lossy();
    [
        "You are working inside Lily Studio, a desktop editor for LilyPond scores, at the request of its user.",
        "The user may be a musician rather than a programmer: answer briefly and in plain words, and talk about the music rather than the code.",
        "Edit the .ly and .ily files of this folder directly. Lily Studio reloads a changed file in its editor and engraves the score again by itself.",
        &format!(
            "After an edit, check that the score still compiles: `{lilypond} -dbackend=svg -o {out_dir}/check <score.ly>`, run on the score that has \\score or \\book, even when you edited a file it \\includes."
        ),
        "Never write output files next to the sources. If lilypond reports errors, fix the first one and compile again.",
        "A `warning: bar check failed` means the bar before that | has the wrong length: recount it, do not remove the bar check. Keep each file's \\version line.",
    ]
    .join("\n")
}

/// The prompt of one turn: the instructions on the first, then where the user
/// is, then whether the turn is read-only, then what they wrote.
pub fn turn_prompt(text: &str, context: &PromptContext) -> String {
    let mut parts: Vec<String> = Vec::new();
    if context.first {
        parts.push(format!(
            "<lily-studio>\n{}\n</lily-studio>",
            instructions(context.lilypond.as_deref())
        ));
    }
    let mut place: Vec<String> = Vec::new();
    if let Some(file) = context.file.as_deref().filter(|file| !file.is_empty()) {
        place.push(format!(
            "The file open in the editor is {}.",
            relative_to(&[&context.folder], file)
        ));
    }
    if let Some(Selection {
        start_line,
        end_line,
        text: selected,
    }) = &context.selection
    {
        let lines = if start_line == end_line {
            format!("line {start_line}")
        } else {
            format!("lines {start_line}–{end_line}")
        };
        place.push(format!(
            "The user has selected {lines} of it:\n```lilypond\n{selected}\n```"
        ));
    }
    if !place.is_empty() {
        parts.push(format!("<editor>\n{}\n</editor>", place.join("\n")));
    }
    if !context.images.is_empty() {
        let files: Vec<String> = context
            .images
            .iter()
            .map(|image| format!("- {image}"))
            .collect();
        let count = match context.images.len() {
            1 => "an image".to_owned(),
            n => format!("{n} images"),
        };
        parts.push(format!(
            "<attachments>\nThe user pasted {count} with this message. Look at them before you answer; they are saved as:\n{}\n</attachments>",
            files.join("\n")
        ));
    }
    if context.read_only {
        parts.push(
            "<lily-studio>\nThis turn is read-only: answer without changing any files or running commands.\n</lily-studio>"
                .to_owned(),
        );
    }
    parts.push(text.to_owned());
    parts.join("\n\n")
}

/// `file` relative to `folder` when inside it, else as it is. `folder` may be
/// given as several spellings of one directory: an agent may report its files
/// under the real path (`/private/var/…` for `/var/…` on macOS).
pub fn relative_to<S: AsRef<str>>(folder: &[S], file: &str) -> String {
    for root in folder {
        let relative = js::relative(root.as_ref(), file);
        if !relative.is_empty() && !relative.starts_with("..") && !relative.starts_with('/') {
            return relative;
        }
    }
    file.to_owned()
}

/// A folder's spellings for `relative_to`: as given, and its real path when that differs.
pub async fn spellings(folder: &str) -> Vec<String> {
    let real = tokio::fs::canonicalize(folder)
        .await
        .map(|real| real.to_string_lossy().into_owned())
        .unwrap_or_else(|_| folder.to_owned());
    if real == folder {
        vec![real]
    } else {
        vec![folder.to_owned(), real]
    }
}

// ---------------------------------------------------------------------------
// Reading the output

const MAX_TOOL_TEXT: usize = 160;

fn short(text: &str) -> String {
    js::ellipsis(js::one_line(text), MAX_TOOL_TEXT)
}

static EMPTY: LazyLock<Map<String, Value>> = LazyLock::new(Map::new);

/// `value` as an object; an empty one for anything else.
fn record(value: Option<&Value>) -> &Map<String, Value> {
    value.and_then(Value::as_object).unwrap_or(&EMPTY)
}

/// `value` as a string; empty for anything else.
fn str_of(value: Option<&Value>) -> &str {
    value.and_then(Value::as_str).unwrap_or("")
}

/// A JSON line as an object; `None` when it is not JSON. Anything but an
/// object reads as an empty one.
fn parse_line(line: &str) -> Option<Map<String, Value>> {
    match serde_json::from_str::<Value>(line).ok()? {
        Value::Object(map) => Some(map),
        _ => Some(Map::new()),
    }
}

/// A tool call of Claude Code, in words; `None` for bookkeeping that says nothing.
fn claude_tool<S: AsRef<str>>(name: &str, input: &Map<String, Value>, cwd: &[S]) -> Option<String> {
    let file = [
        input.get("file_path"),
        input.get("path"),
        input.get("notebook_path"),
    ]
    .into_iter()
    .map(str_of)
    .find(|file| !file.is_empty())
    .unwrap_or("");
    let place = if file.is_empty() {
        String::new()
    } else {
        relative_to(cwd, file)
    };
    Some(match name {
        "Read" => format!("Read {place}"),
        "Edit" | "MultiEdit" | "NotebookEdit" => format!("Edited {place}"),
        "Write" => format!("Wrote {place}"),
        "Bash" => format!("Ran {}", short(str_of(input.get("command")))),
        "Glob" | "Grep" => format!("Searched for {}", short(str_of(input.get("pattern")))),
        "LS" => format!("Listed {}", if place.is_empty() { "." } else { &place }),
        "TodoWrite" => return None,
        _ => format!("Used {name}"),
    })
}

/// One line of `claude -p --output-format stream-json --verbose`: the session
/// id from `system/init`, the text and tool calls of `assistant` messages, and
/// the `result` that ends the turn.
pub fn parse_claude_line<S: AsRef<str>>(line: &str, cwd: &[S]) -> Vec<AgentEvent> {
    let Some(event) = parse_line(line) else {
        return Vec::new();
    };
    let kind = event.get("type").and_then(Value::as_str);
    let mut events = Vec::new();
    if kind == Some("system")
        && event.get("subtype").and_then(Value::as_str) == Some("init")
        && !str_of(event.get("session_id")).is_empty()
    {
        events.push(AgentEvent::Session(
            str_of(event.get("session_id")).to_owned(),
        ));
    } else if kind == Some("assistant") {
        let content = record(event.get("message"))
            .get("content")
            .and_then(Value::as_array);
        for block in content.into_iter().flatten() {
            let part = record(Some(block));
            let part_type = part.get("type").and_then(Value::as_str);
            let text = js::trim(str_of(part.get("text")));
            if part_type == Some("text") && !text.is_empty() {
                events.push(entry(Role::Agent, text));
            }
            if part_type == Some("tool_use")
                && let Some(text) =
                    claude_tool(str_of(part.get("name")), record(part.get("input")), cwd)
            {
                events.push(entry(Role::Tool, text));
            }
        }
    } else if kind == Some("result") {
        let denials = event.get("permission_denials").and_then(Value::as_array);
        let mut denied: Vec<String> = Vec::new();
        for denial in denials.into_iter().flatten() {
            let denial = record(Some(denial));
            let name = str_of(denial.get("tool_name"));
            let text = claude_tool(name, record(denial.get("tool_input")), cwd)
                .unwrap_or_else(|| name.to_owned());
            if !denied.contains(&text) {
                denied.push(text);
            }
        }
        if !denied.is_empty() {
            events.push(entry(
                Role::Error,
                format!("Not allowed in Lily Studio: {}", denied.join("; ")),
            ));
        }
        let subtype = event.get("subtype").and_then(Value::as_str);
        let failed = event.get("is_error") == Some(&Value::Bool(true))
            || subtype.is_some_and(|subtype| subtype != "success");
        if failed {
            let result = str_of(event.get("result"));
            let text = if result.is_empty() {
                format!(
                    "Claude Code stopped: {}",
                    subtype
                        .filter(|subtype| !subtype.is_empty())
                        .unwrap_or("error")
                )
            } else {
                result.to_owned()
            };
            events.push(entry(Role::Error, text));
        }
        events.push(AgentEvent::Done { ok: !failed });
    }
    events
}

/// `/bin/zsh -lc "cat a.ly"` → `cat a.ly`: Codex runs each command through a shell.
pub fn unwrap_shell(command: &str) -> String {
    // JavaScript's `(['"])(…)\1`, without the back-reference the regex crate lacks.
    static SHELL: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r#"^\S*/(?:ba|z)?sh\s+-l?c\s+(?:'([\s\S]*)'|"([\s\S]*)")$"#)
            .expect("a valid pattern")
    });
    SHELL
        .captures(js::trim(command))
        .and_then(|found| found.get(1).or_else(|| found.get(2)))
        .map_or_else(|| command.to_owned(), |inner| inner.as_str().to_owned())
}

/// A JSON number as JavaScript prints it.
fn js_number(value: &serde_json::Number) -> String {
    if let Some(integer) = value.as_i64() {
        return integer.to_string();
    }
    match value.as_f64() {
        Some(float) if float.fract() == 0.0 && float.abs() < 1e21 => format!("{float:.0}"),
        Some(float) => float.to_string(),
        None => value.to_string(),
    }
}

/// One line of `codex exec --json`: `thread.started` names the session,
/// completed items are what the agent said and did, and `turn.completed` or
/// `turn.failed` ends the turn.
pub fn parse_codex_line<S: AsRef<str>>(line: &str, cwd: &[S]) -> Vec<AgentEvent> {
    let Some(event) = parse_line(line) else {
        return Vec::new();
    };
    match event.get("type").and_then(Value::as_str) {
        Some("thread.started") => {
            let id = str_of(event.get("thread_id"));
            return if id.is_empty() {
                Vec::new()
            } else {
                vec![AgentEvent::Session(id.to_owned())]
            };
        }
        Some("turn.completed") => return vec![AgentEvent::Done { ok: true }],
        Some("turn.failed") => {
            let message = str_of(record(event.get("error")).get("message"));
            let text = if message.is_empty() {
                "Codex stopped with an error."
            } else {
                message
            };
            return vec![entry(Role::Error, text), AgentEvent::Done { ok: false }];
        }
        Some("error") => {
            let message = str_of(event.get("message"));
            return if message.is_empty() {
                Vec::new()
            } else {
                vec![entry(Role::Error, message)]
            };
        }
        Some("item.completed") => {}
        _ => return Vec::new(),
    }
    let item = record(event.get("item"));
    match item.get("type").and_then(Value::as_str) {
        Some("agent_message") => {
            let text = js::trim(str_of(item.get("text")));
            if text.is_empty() {
                Vec::new()
            } else {
                vec![entry(Role::Agent, text)]
            }
        }
        Some("command_execution") => {
            let code = match item.get("exit_code") {
                Some(Value::Number(code)) if code.as_f64() != Some(0.0) => {
                    format!(" (exit code {})", js_number(code))
                }
                _ => String::new(),
            };
            let command = unwrap_shell(str_of(item.get("command")));
            vec![entry(Role::Tool, format!("Ran {}{code}", short(&command)))]
        }
        Some("file_change") => {
            let changes = item.get("changes").and_then(Value::as_array);
            changes
                .into_iter()
                .flatten()
                .map(|change| {
                    let change = record(Some(change));
                    let verb = match str_of(change.get("kind")) {
                        "add" => "Wrote",
                        "delete" => "Deleted",
                        _ => "Edited",
                    };
                    entry(
                        Role::Tool,
                        format!("{verb} {}", relative_to(cwd, str_of(change.get("path")))),
                    )
                })
                .collect()
        }
        Some("mcp_tool_call") => {
            let tool = [item.get("tool"), item.get("server")]
                .into_iter()
                .map(str_of)
                .find(|name| !name.is_empty());
            vec![entry(
                Role::Tool,
                format!("Used {}", tool.unwrap_or("a tool")),
            )]
        }
        Some("web_search") => {
            vec![entry(
                Role::Tool,
                format!("Searched the web for {}", short(str_of(item.get("query")))),
            )]
        }
        Some("error") => {
            let message = str_of(item.get("message"));
            if message.is_empty() {
                Vec::new()
            } else {
                vec![entry(Role::Error, message)]
            }
        }
        // reasoning, todo_list: the agent's own bookkeeping.
        _ => Vec::new(),
    }
}

pub fn parse_agent_line<S: AsRef<str>>(id: AgentId, line: &str, cwd: &[S]) -> Vec<AgentEvent> {
    match id {
        AgentId::Claude => parse_claude_line(line, cwd),
        AgentId::Codex => parse_codex_line(line, cwd),
    }
}

// ---------------------------------------------------------------------------
// Running a turn

pub struct RunOptions {
    pub id: AgentId,
    pub binary: String,
    pub args: Vec<String>,
    pub cwd: String,
    /// The spellings of `cwd` that paths in the output are made relative to; `cwd` when not given.
    pub roots: Option<Vec<String>>,
    pub env: Env,
    /// Called for each event, in order, from the task that reads the output.
    /// Dropped once the run is over.
    pub on_event: Box<dyn FnMut(AgentEvent) + Send + 'static>,
}

struct RunState {
    pid: Option<u32>,
    stopped: AtomicBool,
    exited: AtomicBool,
}

/// One turn in progress. Clones share the turn.
#[derive(Clone)]
pub struct AgentRun {
    state: Arc<RunState>,
    done: watch::Receiver<bool>,
}

impl AgentRun {
    /// Resolves when the process has exited and every event was delivered.
    pub async fn done(&self) {
        let mut done = self.done.clone();
        // An error means the run's task is gone, which is also the end.
        let _ = done.wait_for(|done| *done).await;
    }

    /// Ends the agent and whatever it started: SIGTERM to its process group.
    pub fn stop(&self) {
        let state = &self.state;
        let Some(pid) = state.pid.and_then(|pid| libc::pid_t::try_from(pid).ok()) else {
            return;
        };
        if state.exited.load(Ordering::SeqCst) || state.stopped.swap(true, Ordering::SeqCst) {
            return;
        }
        // SAFETY: kill(2) takes plain integers; a negative pid names the group.
        unsafe {
            if libc::kill(-pid, libc::SIGTERM) != 0 {
                libc::kill(pid, libc::SIGTERM);
            }
        }
    }

    /// The same turn: clones of one `AgentRun` are the same.
    pub fn same(&self, other: &AgentRun) -> bool {
        Arc::ptr_eq(&self.state, &other.state)
    }
}

/// Delivers events and notes whether the closing `done` came.
struct Delivery {
    on_event: Box<dyn FnMut(AgentEvent) + Send + 'static>,
    finished: bool,
}

impl Delivery {
    fn emit(&mut self, event: AgentEvent) {
        if matches!(event, AgentEvent::Done { .. }) {
            self.finished = true;
        }
        (self.on_event)(event);
    }

    fn line(&mut self, id: AgentId, line: &str, roots: &[String]) {
        let line = js::trim(line);
        if !line.is_empty() {
            for event in parse_agent_line(id, line, roots) {
                self.emit(event);
            }
        }
    }

    /// The end of the turn: an error and a `done` when the agent did not close it.
    fn end(mut self, message: Option<String>) {
        if !self.finished {
            if let Some(message) = message {
                self.emit(entry(Role::Error, message));
            }
            self.emit(AgentEvent::Done { ok: false });
        }
    }
}

/// How much of stderr is kept, from its end.
const STDERR_TAIL: usize = 4_000;

/// Runs one turn; call it inside a Tokio runtime. Events arrive line by line;
/// a turn that ends without its closing event (the agent crashed, was not
/// signed in, or was stopped) gets an error entry with the end of stderr, and
/// a `done`.
pub fn run_agent(options: RunOptions) -> AgentRun {
    let RunOptions {
        id,
        binary,
        args,
        cwd,
        roots,
        env,
        on_event,
    } = options;
    let roots = roots.unwrap_or_else(|| vec![cwd.clone()]);
    let mut delivery = Delivery {
        on_event,
        finished: false,
    };
    let (done_tx, done_rx) = watch::channel(false);
    // Its own process group, so Stop ends the commands the agent started too.
    let spawned = Command::new(&binary)
        .args(&args)
        .current_dir(&cwd)
        .env_clear()
        .envs(&env)
        .env("PWD", &cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .spawn();
    let mut child = match spawned {
        Ok(child) => child,
        Err(error) => {
            let state = Arc::new(RunState {
                pid: None,
                stopped: AtomicBool::new(false),
                exited: AtomicBool::new(true),
            });
            tokio::spawn(async move {
                delivery.end(Some(format!("{} did not start: {error}", agent_label(id))));
                let _ = done_tx.send(true);
            });
            return AgentRun {
                state,
                done: done_rx,
            };
        }
    };
    let state = Arc::new(RunState {
        pid: child.id(),
        stopped: AtomicBool::new(false),
        exited: AtomicBool::new(false),
    });
    let run = AgentRun {
        state: state.clone(),
        done: done_rx,
    };
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    tokio::spawn(async move {
        let read_stdout = async {
            let Some(stdout) = stdout else { return };
            let mut reader = BufReader::new(stdout);
            let mut line = Vec::new();
            loop {
                line.clear();
                match reader.read_until(b'\n', &mut line).await {
                    Ok(0) | Err(_) => break,
                    // The last line may come without its newline, at the end.
                    Ok(_) => delivery.line(id, &String::from_utf8_lossy(&line), &roots),
                }
            }
        };
        let read_stderr = async {
            let mut tail = Vec::new();
            if let Some(mut stderr) = stderr {
                let _ = stderr.read_to_end(&mut tail).await;
            }
            js::suffix(&String::from_utf8_lossy(&tail), STDERR_TAIL).to_owned()
        };
        let wait = async {
            let status = child.wait().await;
            state.exited.store(true, Ordering::SeqCst);
            status
        };
        let ((), stderr, status) = tokio::join!(read_stdout, read_stderr, wait);
        let message = if state.stopped.load(Ordering::SeqCst) {
            "Stopped.".to_owned()
        } else {
            let lines: Vec<&str> = js::trim(&stderr).split('\n').collect();
            let tail = lines[lines.len().saturating_sub(6)..].join("\n");
            let code = match status.as_ref().ok().and_then(|status| status.code()) {
                Some(code) => format!(" (exit code {code})"),
                None => String::new(),
            };
            let tail = if tail.is_empty() {
                String::new()
            } else {
                format!("\n{tail}")
            };
            format!("{} ended unexpectedly{code}.{tail}", agent_label(id))
        };
        delivery.end(Some(message));
        let _ = done_tx.send(true);
    });
    run
}
