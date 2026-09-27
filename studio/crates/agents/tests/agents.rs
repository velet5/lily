//! The TypeScript's test/agents.test.ts, ported: arguments, prompt, the JSONL
//! of Claude Code 2.1.282 and Codex 0.157.0, detection, runs, the store and a
//! two-turn chat (D40).

use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use lily_agents::agents::{
    AgentEvent, AgentId, AgentState, AgentStatus, ChatEntry, DetectAgentOptions, PromptContext,
    Role, RunOptions, Selection, TurnOptions, agent_args, agent_env, agent_path, detect_agent,
    parse_claude_line, parse_codex_line, relative_to, run_agent, turn_prompt, unwrap_shell,
};
use lily_agents::{
    AgentChats, AgentChatsOptions, ChatEvent, ChatMessage, ChatStore, chat_title, process_env,
};
use serde_json::json;

const CWD: &[&str] = &["/Users/me/Scores"];

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_owned()).collect()
}

fn tool(text: &str) -> AgentEvent {
    AgentEvent::Entry(ChatEntry::new(Role::Tool, text))
}

fn said(role: Role, text: &str) -> AgentEvent {
    AgentEvent::Entry(ChatEntry::new(role, text))
}

/// A scratch directory under its real path, as the agents report it.
fn scratch() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::Builder::new()
        .prefix("lily-studio-agents-")
        .tempdir()
        .expect("a temp dir");
    let real = dir.path().canonicalize().expect("its real path");
    (dir, real)
}

fn script(file: &Path, body: &str) -> String {
    std::fs::write(file, body).expect("the script is written");
    std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o755))
        .expect("it is executable");
    file.to_string_lossy().into_owned()
}

/// A stand-in agent: prints `lines`, then exits with `code`.
fn fake_agent(dir: &Path, name: &str, lines: &[&str], code: i32) -> String {
    let body: Vec<String> = lines
        .iter()
        .map(|line| format!("printf '%s\\n' '{}'", line.replace('\'', "'\\''")))
        .collect();
    script(
        &dir.join(name),
        &format!("#!/bin/sh\n{}\nexit {code}\n", body.join("\n")),
    )
}

// ---------------------------------------------------------------------------
// agent_args

#[test]
fn claude_args_headless_stream_json_edits_accepted_lilypond_the_only_command() {
    let turn = TurnOptions {
        prompt: "Hi".into(),
        lilypond: Some("/opt/lilypond/bin/lilypond".into()),
        model: Some(" sonnet ".into()),
        ..Default::default()
    };
    let args = agent_args(AgentId::Claude, &turn);
    assert_eq!(
        args[..8],
        strings(&[
            "-p",
            "Hi",
            "--output-format",
            "stream-json",
            "--verbose",
            "--permission-mode",
            "acceptEdits",
            "--allowedTools"
        ])
    );
    assert!(args.contains(&"Bash(/opt/lilypond/bin/lilypond:*)".to_owned()));
    assert!(args.contains(&"Bash(lilypond:*)".to_owned()));
    assert!(!args.contains(&"Bash".to_owned()), "no unrestricted Bash");
    assert_eq!(args[args.len() - 2..], strings(&["--model", "sonnet"]));
    assert!(!args.contains(&"--resume".to_owned()));
}

#[test]
fn claude_args_a_later_turn_resumes_the_session() {
    let turn = TurnOptions {
        prompt: "More".into(),
        session_id: Some("abc".into()),
        ..Default::default()
    };
    let args = agent_args(AgentId::Claude, &turn);
    let resume = args
        .iter()
        .position(|arg| arg == "--resume")
        .expect("--resume");
    assert_eq!(args[resume + 1], "abc");
    assert!(!args.contains(&"--model".to_owned()));
}

#[test]
fn codex_args_exec_json_in_the_workspace_write_sandbox_the_prompt_last() {
    let turn = TurnOptions {
        prompt: "Hi".into(),
        ..Default::default()
    };
    assert_eq!(
        agent_args(AgentId::Codex, &turn),
        strings(&[
            "exec",
            "--json",
            "--skip-git-repo-check",
            "-c",
            "sandbox_mode=\"workspace-write\"",
            "-c",
            "approval_policy=\"never\"",
            "Hi",
        ])
    );
}

#[test]
fn codex_args_a_later_turn_is_exec_resume_with_the_sandbox_as_config() {
    let turn = TurnOptions {
        prompt: "More".into(),
        session_id: Some("t-1".into()),
        model: Some("gpt-5".into()),
        ..Default::default()
    };
    let args = agent_args(AgentId::Codex, &turn);
    assert_eq!(args[..2], strings(&["exec", "resume"]));
    assert!(
        !args.contains(&"--sandbox".to_owned()) && !args.contains(&"-C".to_owned()),
        "resume takes neither"
    );
    assert_eq!(
        args[args.len() - 4..],
        strings(&["-m", "gpt-5", "t-1", "More"])
    );
}

// ---------------------------------------------------------------------------
// turn_prompt

fn context(first: bool) -> PromptContext {
    PromptContext {
        folder: CWD[0].into(),
        file: Some(format!("{}/parts/violin.ily", CWD[0])),
        lilypond: Some("/bin/lilypond".into()),
        first,
        selection: None,
    }
}

#[test]
fn the_first_turn_carries_the_instructions_the_file_and_the_selection() {
    let selection = Selection {
        start_line: 3,
        end_line: 4,
        text: "c4 d".into(),
    };
    let prompt = turn_prompt(
        "Make it louder",
        &PromptContext {
            selection: Some(selection),
            ..context(true)
        },
    );
    assert!(prompt.starts_with("<lily-studio>\n"));
    assert!(prompt.contains("/bin/lilypond -dbackend=svg -o "));
    assert!(prompt.contains("The file open in the editor is parts/violin.ily."));
    assert!(prompt.contains("selected lines 3–4 of it:\n```lilypond\nc4 d\n```"));
    assert!(prompt.ends_with("\n\nMake it louder"));
}

#[test]
fn later_turns_only_say_where_the_user_is() {
    let prompt = turn_prompt("Again", &context(false));
    assert!(!prompt.contains("<lily-studio>"));
    assert_eq!(
        prompt,
        "<editor>\nThe file open in the editor is parts/violin.ily.\n</editor>\n\nAgain"
    );
    let bare = PromptContext {
        folder: CWD[0].into(),
        ..Default::default()
    };
    assert_eq!(turn_prompt("Just this", &bare), "Just this");
    let one = Selection {
        start_line: 5,
        end_line: 5,
        text: "e".into(),
    };
    let prompt = turn_prompt(
        "One",
        &PromptContext {
            selection: Some(one),
            ..context(false)
        },
    );
    assert!(prompt.contains("The user has selected line 5 of it:"));
}

// ---------------------------------------------------------------------------
// parse_claude_line: lines of `claude -p --output-format stream-json --verbose` 2.1, shortened.

#[test]
fn claude_the_session_text_tool_calls_and_the_result() {
    assert_eq!(
        parse_claude_line(
            r#"{"type":"system","subtype":"init","cwd":"/x","session_id":"6ff8","tools":[]}"#,
            CWD
        ),
        [AgentEvent::Session("6ff8".into())]
    );
    assert_eq!(
        parse_claude_line(
            r#"{"type":"system","subtype":"thinking_tokens","estimated_tokens":50}"#,
            CWD
        ),
        []
    );
    let edit = json!({
        "type": "assistant",
        "message": {
            "content": [
                { "type": "thinking", "thinking": "" },
                { "type": "tool_use", "name": "Edit", "input": { "file_path": format!("{}/a.ly", CWD[0]), "old_string": "f", "new_string": "g" } },
                { "type": "tool_use", "name": "Bash", "input": { "command": "lilypond -dbackend=svg -o /tmp/x a.ly" } },
                { "type": "tool_use", "name": "TodoWrite", "input": {} },
                { "type": "text", "text": "Done.\n" },
            ],
        },
    });
    assert_eq!(
        parse_claude_line(&edit.to_string(), CWD),
        [
            tool("Edited a.ly"),
            tool("Ran lilypond -dbackend=svg -o /tmp/x a.ly"),
            said(Role::Agent, "Done.")
        ]
    );
    assert_eq!(
        parse_claude_line(
            r#"{"type":"user","message":{"content":[{"type":"tool_result","content":"ok"}]}}"#,
            CWD
        ),
        []
    );
    assert_eq!(
        parse_claude_line(
            r#"{"type":"result","subtype":"success","is_error":false,"result":"Done.","permission_denials":[]}"#,
            CWD
        ),
        [AgentEvent::Done { ok: true }]
    );
}

#[test]
fn claude_a_failed_turn_and_denied_tools_become_errors() {
    let result = json!({
        "type": "result",
        "subtype": "success",
        "is_error": true,
        "result": "Invalid API key · Please run /login",
        "permission_denials": [
            { "tool_name": "Bash", "tool_input": { "command": "rm -rf build" } },
            { "tool_name": "Bash", "tool_input": { "command": "rm   -rf\nbuild" } },
        ],
    });
    assert_eq!(
        parse_claude_line(&result.to_string(), CWD),
        [
            said(Role::Error, "Not allowed in Lily Studio: Ran rm -rf build"),
            said(Role::Error, "Invalid API key · Please run /login"),
            AgentEvent::Done { ok: false },
        ]
    );
    assert_eq!(
        parse_claude_line(r#"{"type":"result","subtype":"error_max_turns"}"#, CWD),
        [
            said(Role::Error, "Claude Code stopped: error_max_turns"),
            AgentEvent::Done { ok: false }
        ]
    );
}

#[test]
fn claude_not_json_nothing() {
    assert_eq!(parse_claude_line("Warning: something", CWD), []);
    assert_eq!(parse_claude_line("[1,2]", CWD), []);
}

#[test]
fn claude_long_commands_are_shortened() {
    let line = json!({
        "type": "assistant",
        "message": { "content": [{ "type": "tool_use", "name": "Bash", "input": { "command": "x".repeat(300) } }] },
    });
    let events = parse_claude_line(&line.to_string(), CWD);
    let [AgentEvent::Entry(entry)] = events.as_slice() else {
        panic!("one entry: {events:?}")
    };
    assert_eq!(entry.text, format!("Ran {}…", "x".repeat(159)));
}

// ---------------------------------------------------------------------------
// parse_codex_line: lines of `codex exec --json` 0.157, shortened.

#[test]
fn codex_the_thread_messages_commands_file_changes_and_the_end_of_the_turn() {
    assert_eq!(
        parse_codex_line(r#"{"type":"thread.started","thread_id":"01a0"}"#, CWD),
        [AgentEvent::Session("01a0".into())]
    );
    assert_eq!(parse_codex_line(r#"{"type":"turn.started"}"#, CWD), []);
    assert_eq!(
        parse_codex_line(
            r#"{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I’ll update the note.\n"}}"#,
            CWD
        ),
        [said(Role::Agent, "I’ll update the note.")]
    );
    assert_eq!(
        parse_codex_line(
            r#"{"type":"item.started","item":{"id":"item_2","type":"command_execution","command":"/bin/zsh -lc 'cat a.ly'","status":"in_progress"}}"#,
            CWD
        ),
        []
    );
    assert_eq!(
        parse_codex_line(
            r#"{"type":"item.completed","item":{"id":"item_2","type":"command_execution","command":"/bin/zsh -lc 'cat a.ly'","exit_code":0,"status":"completed"}}"#,
            CWD
        ),
        [tool("Ran cat a.ly")]
    );
    assert_eq!(
        parse_codex_line(
            r#"{"type":"item.completed","item":{"id":"item_4","type":"command_execution","command":"/bin/zsh -lc lilypond","exit_code":1,"status":"failed"}}"#,
            CWD
        ),
        [tool("Ran /bin/zsh -lc lilypond (exit code 1)")]
    );
    let change = json!({
        "type": "item.completed",
        "item": {
            "type": "file_change",
            "changes": [{ "path": format!("{}/a.ly", CWD[0]), "kind": "update" }, { "path": format!("{}/b.ly", CWD[0]), "kind": "add" }],
            "status": "completed",
        },
    });
    assert_eq!(
        parse_codex_line(&change.to_string(), CWD),
        [tool("Edited a.ly"), tool("Wrote b.ly")]
    );
    assert_eq!(
        parse_codex_line(
            r#"{"type":"item.completed","item":{"type":"reasoning","text":"…"}}"#,
            CWD
        ),
        []
    );
    assert_eq!(
        parse_codex_line(
            r#"{"type":"turn.completed","usage":{"input_tokens":1}}"#,
            CWD
        ),
        [AgentEvent::Done { ok: true }]
    );
}

#[test]
fn codex_a_failed_turn() {
    assert_eq!(
        parse_codex_line(
            r#"{"type":"turn.failed","error":{"message":"Not signed in"}}"#,
            CWD
        ),
        [
            said(Role::Error, "Not signed in"),
            AgentEvent::Done { ok: false }
        ]
    );
    assert_eq!(
        parse_codex_line(r#"{"type":"turn.failed"}"#, CWD),
        [
            said(Role::Error, "Codex stopped with an error."),
            AgentEvent::Done { ok: false }
        ]
    );
}

#[test]
fn codex_unwrap_shell() {
    assert_eq!(unwrap_shell("/bin/zsh -lc 'cat a.ly'"), "cat a.ly");
    assert_eq!(unwrap_shell("/bin/bash -lc \"ls -la\""), "ls -la");
    assert_eq!(unwrap_shell("/bin/sh -c 'a' \"b\""), "/bin/sh -c 'a' \"b\"");
    assert_eq!(unwrap_shell("ls"), "ls");
}

// ---------------------------------------------------------------------------
// Paths and environment

#[test]
fn relative_to_takes_any_spelling_of_the_folder() {
    assert_eq!(
        relative_to(&["/var/x", "/private/var/x"], "/private/var/x/a.ly"),
        "a.ly"
    );
    assert_eq!(
        relative_to(&["/var/x"], "/elsewhere/a.ly"),
        "/elsewhere/a.ly"
    );
    assert_eq!(relative_to(&["/var/x"], "/var/x"), "/var/x");
}

#[test]
fn agent_path_the_login_shell_first_then_the_app_then_the_installers() {
    let value = agent_path(
        "/login/bin:/usr/bin",
        Some("/usr/bin:/bin"),
        Some("/home/me"),
    );
    let value: Vec<&str> = value.split(':').collect();
    assert_eq!(value[..3], ["/login/bin", "/usr/bin", "/bin"]);
    assert!(value.contains(&"/home/me/.local/bin"));
    let mut unique = value.clone();
    unique.sort_unstable();
    unique.dedup();
    assert_eq!(unique.len(), value.len());
}

#[test]
fn agent_env_drops_what_would_make_the_agent_think_it_is_nested() {
    let env: HashMap<String, String> = [
        ("CLAUDECODE", "1"),
        ("ELECTRON_RUN_AS_NODE", "1"),
        ("HOME", "/h"),
    ]
    .map(|(k, v)| (k.to_owned(), v.to_owned()))
    .into();
    let expected: HashMap<String, String> = [("HOME", "/h"), ("PATH", "/p"), ("NO_COLOR", "1")]
        .map(|(k, v)| (k.to_owned(), v.to_owned()))
        .into();
    assert_eq!(agent_env("/p", &env), expected);
}

// ---------------------------------------------------------------------------
// detect_agent

#[tokio::test]
async fn detect_found_on_the_path_with_its_version() {
    let (_dir, scratch) = scratch();
    let bin = scratch.join("bin");
    std::fs::create_dir_all(&bin).expect("bin");
    let codex = script(
        &bin.join("codex"),
        "#!/bin/sh\necho \"codex-cli 0.157.0\"\n",
    );
    let options = DetectAgentOptions {
        path_value: bin.to_string_lossy().into_owned(),
        model: Some("gpt-5".into()),
        ..Default::default()
    };
    let status = detect_agent(AgentId::Codex, options).await;
    assert_eq!(
        status,
        AgentStatus {
            id: AgentId::Codex,
            state: AgentState::Ready,
            path: Some(codex),
            version: Some("0.157.0".into()),
            chosen: None,
            model: Some("gpt-5".into()),
            message: "Codex 0.157.0 is ready.".into(),
        }
    );
    assert_eq!(
        serde_json::to_value(&status).expect("json")["message"],
        json!("Codex 0.157.0 is ready.")
    );
    assert!(
        serde_json::to_value(&status)
            .expect("json")
            .get("chosen")
            .is_none()
    );
}

#[tokio::test]
async fn detect_missing_and_a_chosen_path_that_is_gone() {
    let status = detect_agent(AgentId::Claude, DetectAgentOptions::default()).await;
    assert_eq!(status.state, AgentState::Missing);
    assert_eq!(
        status.message,
        "Claude Code is not installed, or Lily Studio cannot find it."
    );
    let options = DetectAgentOptions {
        configured_path: Some("/nowhere/claude".into()),
        ..Default::default()
    };
    let status = detect_agent(AgentId::Claude, options).await;
    assert_eq!(status.state, AgentState::Missing);
    assert_eq!(status.chosen.as_deref(), Some("/nowhere/claude"));
}

#[tokio::test]
async fn detect_broken_when_it_does_not_answer_version() {
    let (_dir, scratch) = scratch();
    let codex = script(&scratch.join("codex"), "#!/bin/sh\nexit 1\n");
    let options = DetectAgentOptions {
        path_value: scratch.to_string_lossy().into_owned(),
        configured_path: Some(codex.clone()),
        version: Some(Arc::new(|_| Box::pin(async { Err("no".to_owned()) }))),
        ..Default::default()
    };
    let status = detect_agent(AgentId::Claude, options).await;
    assert_eq!(status.state, AgentState::Broken);
    assert_eq!(status.path.as_deref(), Some(codex.as_str()));
    // And with the real `--version`, which exits 1.
    let options = DetectAgentOptions {
        configured_path: Some(codex),
        ..Default::default()
    };
    assert_eq!(
        detect_agent(AgentId::Claude, options).await.state,
        AgentState::Broken
    );
}

// ---------------------------------------------------------------------------
// run_agent

async fn run(
    id: AgentId,
    binary: String,
    cwd: &Path,
    stop_after: Option<Duration>,
) -> Vec<AgentEvent> {
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    let run = run_agent(RunOptions {
        id,
        binary,
        args: Vec::new(),
        cwd: cwd.to_string_lossy().into_owned(),
        roots: None,
        env: process_env(),
        on_event: Box::new(move |event| sink.lock().expect("events").push(event)),
    });
    if let Some(after) = stop_after {
        let stopper = run.clone();
        tokio::spawn(async move {
            tokio::time::sleep(after).await;
            stopper.stop();
        });
    }
    run.done().await;
    events.lock().expect("events").clone()
}

#[tokio::test]
async fn run_events_line_by_line_until_done() {
    let (_dir, scratch) = scratch();
    let binary = fake_agent(
        &scratch,
        "ok-agent",
        &[
            r#"{"type":"thread.started","thread_id":"t"}"#,
            "noise",
            r#"{"type":"item.completed","item":{"type":"agent_message","text":"Hi"}}"#,
            r#"{"type":"turn.completed"}"#,
        ],
        0,
    );
    assert_eq!(
        run(AgentId::Codex, binary, &scratch, None).await,
        [
            AgentEvent::Session("t".into()),
            said(Role::Agent, "Hi"),
            AgentEvent::Done { ok: true }
        ]
    );
}

#[tokio::test]
async fn run_the_last_line_without_its_newline_counts() {
    let (_dir, scratch) = scratch();
    let binary = script(
        &scratch.join("tail-agent"),
        "#!/bin/sh\nprintf '%s' '{\"type\":\"turn.completed\"}'\n",
    );
    assert_eq!(
        run(AgentId::Codex, binary, &scratch, None).await,
        [AgentEvent::Done { ok: true }]
    );
}

#[tokio::test]
async fn run_a_crash_without_a_result_an_error_with_the_end_of_stderr() {
    let (_dir, scratch) = scratch();
    let binary = script(
        &scratch.join("crash-agent"),
        "#!/bin/sh\necho \"not logged in\" >&2\nexit 3\n",
    );
    assert_eq!(
        run(AgentId::Claude, binary, &scratch, None).await,
        [
            said(
                Role::Error,
                "Claude Code ended unexpectedly (exit code 3).\nnot logged in"
            ),
            AgentEvent::Done { ok: false }
        ]
    );
}

#[tokio::test]
async fn run_an_agent_that_does_not_start() {
    let (_dir, scratch) = scratch();
    let binary = scratch.join("nothing").to_string_lossy().into_owned();
    let events = run(AgentId::Codex, binary, &scratch, None).await;
    let [AgentEvent::Entry(entry), AgentEvent::Done { ok: false }] = events.as_slice() else {
        panic!("{events:?}")
    };
    assert!(
        entry.text.starts_with("Codex did not start: "),
        "{}",
        entry.text
    );
}

#[tokio::test]
async fn run_stop_ends_it_and_says_so() {
    let (_dir, scratch) = scratch();
    let binary = script(&scratch.join("slow-agent"), "#!/bin/sh\nsleep 30\n");
    let started = std::time::Instant::now();
    assert_eq!(
        run(
            AgentId::Codex,
            binary,
            &scratch,
            Some(Duration::from_millis(100))
        )
        .await,
        [
            said(Role::Error, "Stopped."),
            AgentEvent::Done { ok: false }
        ]
    );
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "the whole group ended"
    );
}

// ---------------------------------------------------------------------------
// ChatStore and AgentChats

#[tokio::test]
async fn store_a_chat_per_folder_kept_across_stores() {
    let (_dir, scratch) = scratch();
    let file = scratch.join("store").join("chats.json");
    let store = ChatStore::new(&file);
    let a = store
        .create_at(
            AgentId::Claude,
            "/one",
            "Transpose   the melody\nup a tone",
            1,
        )
        .await;
    store.create_at(AgentId::Codex, "/two", "Other", 2).await;
    store
        .append_at(&a.id, ChatEntry::new(Role::User, "Transpose"), 3)
        .await;
    store.set_session(&a.id, "s-1").await;
    let again = ChatStore::new(&file);
    let listed: Vec<_> = again
        .list("/one")
        .await
        .into_iter()
        .map(|chat| (chat.title, chat.agent, chat.session_id, chat.updated))
        .collect();
    assert_eq!(
        listed,
        [(
            "Transpose the melody up a tone".to_owned(),
            AgentId::Claude,
            Some("s-1".to_owned()),
            3
        )]
    );
    assert_eq!(
        again.get(&a.id).await.expect("the chat").entries,
        [ChatEntry::new(Role::User, "Transpose")]
    );
    again.delete(&a.id).await;
    assert_eq!(ChatStore::new(&file).list("/one").await, []);
}

#[tokio::test]
async fn store_reads_the_typescript_format_and_drops_what_is_not_a_chat() {
    let (_dir, scratch) = scratch();
    let file = scratch.join("chats.json");
    let written = json!({ "chats": [
        { "id": "a", "agent": "claude", "folder": "/f", "title": "A", "created": 1, "updated": 5,
          "entries": [{ "role": "user", "text": "hi" }, { "role": "agent", "text": "hello" }], "sessionId": "s" },
        { "id": "b", "agent": "codex", "folder": "/f", "title": "B", "created": 2, "updated": 9, "entries": [] },
        { "id": "c", "agent": "gemini", "folder": "/f", "title": "C", "created": 2, "updated": 2, "entries": [] },
        { "id": "d", "agent": "codex", "folder": "/f", "title": "D", "created": 2, "updated": 2, "entries": [{ "role": "x", "text": "" }] },
        { "id": "e", "agent": "codex", "folder": "/f", "title": "E", "created": 2, "updated": 2, "entries": [], "sessionId": null },
        "nonsense",
    ]});
    std::fs::write(&file, written.to_string()).expect("written");
    let store = ChatStore::new(&file);
    let ids: Vec<String> = store
        .list("/f")
        .await
        .into_iter()
        .map(|chat| chat.id)
        .collect();
    assert_eq!(ids, ["b", "a"]);
    store.set_session("b", "t").await;
    let saved: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&file).expect("read")).expect("json");
    assert_eq!(
        saved["chats"][0],
        json!({ "id": "a", "agent": "claude", "folder": "/f", "title": "A", "sessionId": "s", "created": 1, "updated": 5,
                "entries": [{ "role": "user", "text": "hi" }, { "role": "agent", "text": "hello" }] })
    );
    assert_eq!(saved["chats"][1]["sessionId"], json!("t"));
    assert_eq!(saved["chats"].as_array().map(Vec::len), Some(2));

    std::fs::write(&file, "{ damaged").expect("written");
    assert_eq!(ChatStore::new(&file).list("/f").await, []);
    assert_eq!(
        ChatStore::new(scratch.join("missing.json"))
            .list("/f")
            .await,
        []
    );
}

#[tokio::test]
async fn store_keeps_the_newest_200() {
    let (_dir, scratch) = scratch();
    let store = ChatStore::new(scratch.join("chats.json"));
    for now in 0..205 {
        store
            .create_at(AgentId::Claude, "/f", &format!("chat {now}"), now)
            .await;
    }
    let chats = store.list("/f").await;
    assert_eq!(chats.len(), lily_agents::MAX_CHATS);
    assert_eq!(chats.last().map(|chat| chat.title.as_str()), Some("chat 5"));
}

#[test]
fn chat_titles() {
    assert_eq!(chat_title("  "), "New chat");
    assert_eq!(chat_title(&"x".repeat(100)).encode_utf16().count(), 60);
    assert_eq!(chat_title(&"x".repeat(60)), "x".repeat(60));
}

#[test]
fn chat_message_is_read_leniently() {
    let message = ChatMessage::from_value(json!({
        "text": "Fix it", "chatId": 3, "agent": "gemini", "file": "/f/a.ly",
        "selection": { "startLine": 1.0, "endLine": 2, "text": "c" },
    }))
    .expect("a message");
    assert_eq!(
        message,
        ChatMessage {
            text: "Fix it".into(),
            chat_id: None,
            agent: None,
            file: Some("/f/a.ly".into()),
            selection: Some(Selection {
                start_line: 1,
                end_line: 2,
                text: "c".into()
            }),
        }
    );
    let message: ChatMessage =
        serde_json::from_value(json!({ "text": "x", "agent": "codex", "chatId": "c", "selection": { "startLine": 1.5, "endLine": 2, "text": "c" } }))
            .expect("a message");
    assert_eq!(
        (message.agent, message.chat_id.as_deref(), message.selection),
        (Some(AgentId::Codex), Some("c"), None)
    );
    assert_eq!(
        ChatMessage::from_value(json!({ "text": 1 })),
        Err("Expected the text of a message.".to_owned())
    );
    assert!(ChatMessage::from_value(json!(null)).is_err());
}

#[test]
fn events_and_chats_serialize_as_the_renderer_reads_them() {
    let entry = ChatEvent::Entry {
        chat_id: "c".into(),
        entry: ChatEntry::new(Role::Tool, "Edited a.ly"),
    };
    assert_eq!(
        serde_json::to_value(&entry).expect("json"),
        json!({ "kind": "entry", "chatId": "c", "entry": { "role": "tool", "text": "Edited a.ly" } })
    );
    let running = ChatEvent::Running {
        chat_id: "c".into(),
        running: true,
    };
    assert_eq!(
        serde_json::to_value(&running).expect("json"),
        json!({ "kind": "running", "chatId": "c", "running": true })
    );
    let chat = lily_agents::Chat {
        id: "c".into(),
        agent: AgentId::Codex,
        folder: "/f".into(),
        title: "T".into(),
        session_id: None,
        created: 1_700_000_000_000,
        updated: 1_700_000_000_001,
        entries: Vec::new(),
    };
    let open = lily_agents::OpenChat {
        chat: chat.clone(),
        running: false,
    };
    assert_eq!(
        serde_json::to_value(&open).expect("json"),
        json!({ "id": "c", "agent": "codex", "folder": "/f", "title": "T", "created": 1_700_000_000_000_i64,
                "updated": 1_700_000_000_001_i64, "entries": [], "running": false })
    );
    let info = lily_agents::ChatInfo {
        chat: (&chat).into(),
        running: true,
    };
    assert_eq!(
        serde_json::to_value(&info).expect("json").get("entries"),
        None
    );
    assert_eq!(
        serde_json::to_value(&info).expect("json")["running"],
        json!(true)
    );
}

fn ready(
    binary: String,
) -> impl Fn(AgentId) -> std::future::Ready<AgentStatus> + Send + Sync + 'static {
    move |id| {
        std::future::ready(AgentStatus {
            id,
            state: AgentState::Ready,
            path: Some(binary.clone()),
            version: None,
            chosen: None,
            model: None,
            message: "ready".into(),
        })
    }
}

#[tokio::test]
async fn a_message_runs_a_turn_and_the_next_continues_its_session() {
    let (_dir, scratch) = scratch();
    let folder = scratch.join("score");
    std::fs::create_dir_all(&folder).expect("folder");
    let folder = folder.to_string_lossy().into_owned();
    // Answers with its arguments, so the test sees what it was given.
    let binary = script(
        &scratch.join("echo-agent"),
        r#"#!/bin/sh
echo '{"type":"system","subtype":"init","session_id":"s-9"}'
resumed=no
for arg in "$@"; do [ "$arg" = "--resume" ] && resumed=yes; done
echo '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"'"$PWD"'/a.ly"}},{"type":"text","text":"resumed: '$resumed'"}]}}'
echo '{"type":"result","subtype":"success","is_error":false,"result":"ok"}'
"#,
    );
    let events = Arc::new(Mutex::new(Vec::<ChatEvent>::new()));
    let sink = events.clone();
    let chats = AgentChats::new(AgentChatsOptions::new(
        ChatStore::new(scratch.join("chats2.json")),
        move |event| sink.lock().expect("events").push(event),
        ready(binary),
        || async { Some("/bin/lilypond".to_owned()) },
        || async { process_env() },
    ));
    let first = ChatMessage {
        agent: Some(AgentId::Claude),
        text: "Edit it".into(),
        file: Some(format!("{folder}/a.ly")),
        ..Default::default()
    };
    let id = chats.send(first, &folder).await.expect("sent");
    let too_soon = ChatMessage {
        chat_id: Some(id.clone()),
        text: "Too soon".into(),
        ..Default::default()
    };
    assert!(
        chats
            .send(too_soon, &folder)
            .await
            .expect_err("refused")
            .contains("still working")
    );
    chats.settled(&id).await;
    let again = ChatMessage {
        chat_id: Some(id.clone()),
        text: "Again".into(),
        ..Default::default()
    };
    chats.send(again, &folder).await.expect("sent");
    chats.settled(&id).await;
    let chat = chats.get(&id, &folder).await.expect("the chat");
    assert_eq!(chat.chat.session_id.as_deref(), Some("s-9"));
    assert_eq!(
        chat.chat.entries,
        [
            ChatEntry::new(Role::User, "Edit it"),
            ChatEntry::new(Role::Tool, "Edited a.ly"),
            ChatEntry::new(Role::Agent, "resumed: no"),
            ChatEntry::new(Role::User, "Again"),
            ChatEntry::new(Role::Tool, "Edited a.ly"),
            ChatEntry::new(Role::Agent, "resumed: yes"),
        ]
    );
    let events = events.lock().expect("events").clone();
    let running: Vec<bool> = events
        .iter()
        .filter_map(|event| match event {
            ChatEvent::Running { running, .. } => Some(*running),
            ChatEvent::Entry { .. } => None,
        })
        .collect();
    assert_eq!(running, [true, false, true, false]);
    // Each turn's entries come between its `running` events.
    assert!(
        matches!(events[1], ChatEvent::Running { running: true, .. }),
        "{events:?}"
    );
    assert!(chats.get(&id, "/another/folder").await.is_none());
    let elsewhere = ChatMessage {
        chat_id: Some(id.clone()),
        text: "Elsewhere".into(),
        ..Default::default()
    };
    assert!(
        chats
            .send(elsewhere, "/another/folder")
            .await
            .expect_err("refused")
            .contains("another folder")
    );
    assert_eq!(chats.list(&folder).await.len(), 1);
    chats.delete(&id, &folder).await;
    assert!(chats.list(&folder).await.is_empty());
}

#[tokio::test]
async fn an_agent_that_is_not_set_up_the_message_is_kept_with_why() {
    let (_dir, scratch) = scratch();
    let chats = AgentChats::new(AgentChatsOptions::new(
        ChatStore::new(scratch.join("chats3.json")),
        |_| {},
        |id| async move {
            AgentStatus {
                id,
                state: AgentState::Missing,
                path: None,
                version: None,
                chosen: None,
                model: None,
                message: "Codex is not installed, or Lily Studio cannot find it.".into(),
            }
        },
        || async { None },
        || async { process_env() },
    ));
    let message = ChatMessage {
        agent: Some(AgentId::Codex),
        text: "Hello".into(),
        ..Default::default()
    };
    let id = chats.send(message, "/f").await.expect("sent");
    assert_eq!(
        chats.get(&id, "/f").await.expect("the chat").chat.entries,
        [
            ChatEntry::new(Role::User, "Hello"),
            ChatEntry::new(
                Role::Error,
                "Codex is not installed, or Lily Studio cannot find it. Open Agent setup below to set it up."
            ),
        ]
    );
    let empty = ChatMessage {
        agent: Some(AgentId::Codex),
        text: " \n".into(),
        ..Default::default()
    };
    assert_eq!(
        chats.send(empty, "/f").await,
        Err("Write a message first.".to_owned())
    );
    let no_agent = ChatMessage {
        text: "Hi".into(),
        ..Default::default()
    };
    assert_eq!(
        chats.send(no_agent, "/f").await,
        Err("Choose an agent first.".to_owned())
    );
}

#[tokio::test]
async fn a_long_selection_is_cut_and_a_file_outside_the_folder_is_left_out() {
    let (_dir, scratch) = scratch();
    let folder = scratch.to_string_lossy().into_owned();
    // Keeps its prompt, the last argument, for the test to read.
    let binary = script(
        &scratch.join("prompt-agent"),
        r#"#!/bin/sh
for arg; do prompt="$arg"; done
n=$(ls "$PWD" | grep -c '^prompt-[0-9]')
printf '%s' "$prompt" > "$PWD/prompt-$n.txt"
echo '{"type":"turn.completed"}'
"#,
    );
    let chats = AgentChats::new(AgentChatsOptions::new(
        ChatStore::new(scratch.join("chats4.json")),
        |_| {},
        ready(binary),
        || async { None },
        || async { process_env() },
    ));
    let selection = Selection {
        start_line: 1,
        end_line: 1,
        text: "x".repeat(5_000),
    };
    let inside = ChatMessage {
        agent: Some(AgentId::Codex),
        text: "Look".into(),
        file: Some(format!("{folder}/a.ly")),
        selection: Some(selection.clone()),
        ..Default::default()
    };
    let id = chats.send(inside, &folder).await.expect("sent");
    chats.settled(&id).await;
    let outside = ChatMessage {
        chat_id: Some(id.clone()),
        text: "Look".into(),
        file: Some("/elsewhere/a.ly".into()),
        selection: Some(selection),
        ..Default::default()
    };
    chats.send(outside, &folder).await.expect("sent");
    chats.settled(&id).await;
    let first = std::fs::read_to_string(scratch.join("prompt-0.txt")).expect("the first prompt");
    assert!(first.contains("The file open in the editor is a.ly."));
    assert!(first.contains(&format!("\n{}\n```", "x".repeat(4_000))));
    assert!(!first.contains(&"x".repeat(4_001)));
    let second = std::fs::read_to_string(scratch.join("prompt-1.txt")).expect("the second prompt");
    assert!(
        second.starts_with("<lily-studio>"),
        "no session yet, so the instructions again"
    );
    assert!(!second.contains("<editor>"));
    assert!(second.ends_with("\n\nLook"));
}

#[tokio::test]
async fn login_shell_path_is_asked_once() {
    let started = std::time::Instant::now();
    let first = lily_agents::login_shell_path().await;
    assert!(
        started.elapsed() < Duration::from_secs(7),
        "five seconds at most"
    );
    assert!(first.is_empty() || first.contains('/'), "{first}");
    assert_eq!(lily_agents::login_shell_path().await, first);
}
