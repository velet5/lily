//! One user's studio (DECISIONS D55): what the app's main process is for its
//! window, for the page of one signed-in user, run by the gateway in the
//! user's sandbox. It reads calls from stdin and writes answers and events to
//! stdout, one JSON object per line:
//!
//! ```text
//! in:  {"id": 7, "command": "read_file", "args": {"file": "/…/a.ly"}}
//! out: {"id": 7, "ok": "…"}   or   {"id": 7, "error": "…"}
//! out: {"event": {"type": "compile", …}}
//! ```
//!
//! The commands are the app's (src/renderer/bridge.ts), with the paths the
//! app's panels chose passed by the page's own dialogs instead
//! (commands.rs). It ends, stopping lilypond, when stdin ends.
mod commands;

use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;

use clap::Args;
use lily_session::{Paths, Studio, StudioEvent, StudioOptions};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

#[derive(Args)]
pub struct WorkerArgs {
    /// The user's scores: all the page may touch.
    #[arg(long)]
    pub scores: PathBuf,
    /// The user's settings, playback setups and recent list.
    #[arg(long)]
    pub profile: PathBuf,
    /// @lily/common's runtime/.
    #[arg(long)]
    pub runtime: PathBuf,
}

#[derive(Deserialize)]
struct Call {
    id: u64,
    command: String,
    #[serde(default)]
    args: Value,
}

pub async fn run(args: WorkerArgs) -> ExitCode {
    for dir in [&args.scores, &args.profile] {
        if let Err(error) = tokio::fs::create_dir_all(dir).await {
            eprintln!("worker: {}: {error}", dir.display());
            return ExitCode::FAILURE;
        }
    }
    let scores = lily_engrave::paths::resolve(&args.scores);
    let mut options = StudioOptions::new(Paths {
        data: args.profile.clone(),
        documents: scores.clone(),
        runtime: args.runtime.clone(),
    });
    // The whole workspace is the user's; the sample goes in it, not a folder of its own.
    options.root = Some(scores.clone());
    options.sample_folder = Some(scores.clone());
    let studio = Studio::new(options).await;

    // One writer, so lines never interleave.
    let (out, mut lines) = mpsc::unbounded_channel::<String>();
    let writer = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(line) = lines.recv().await {
            if stdout.write_all(line.as_bytes()).await.is_err()
                || stdout.write_all(b"\n").await.is_err()
                || stdout.flush().await.is_err()
            {
                break;
            }
        }
    });
    studio.subscribe({
        let out = out.clone();
        move |event| {
            if let Ok(line) = serde_json::to_string(&json!({ "event": event })) {
                let _ = out.send(line);
            }
        }
    });

    // The welcome screen and the menu bar list it again (D49).
    studio.recent.on_change({
        let studio = Arc::downgrade(&studio);
        move |_| {
            if let Some(studio) = studio.upgrade() {
                studio.send(StudioEvent::RecentChanged);
            }
        }
    });

    let worker = Arc::new(commands::Worker::new(studio.clone(), scores));
    let mut stdin = BufReader::new(tokio::io::stdin()).lines();
    while let Ok(Some(line)) = stdin.next_line().await {
        let call: Call = match serde_json::from_str(&line) {
            Ok(call) => call,
            Err(error) => {
                eprintln!("worker: not a call: {error}");
                continue;
            }
        };
        let id = call.id;
        // In the order the page sent them, as Tauri runs the app's
        // synchronous commands: an older text must never replace a newer one.
        if let Some(result) = worker.call_in_order(&call.command, &call.args) {
            let _ = out.send(answer(id, result));
            continue;
        }
        let worker = worker.clone();
        let out = out.clone();
        tokio::spawn(async move {
            let result = worker.call(&call.command, call.args).await;
            let _ = out.send(answer(id, result));
        });
    }
    studio.dispose().await;
    // The studio's parts hold it, so it lives on: its sink lets the writer go.
    studio.subscribe(|_| {});
    drop(out);
    // What is still being answered goes out, unless it hangs.
    let _ = tokio::time::timeout(std::time::Duration::from_secs(2), writer).await;
    ExitCode::SUCCESS
}

fn answer(id: u64, result: Result<Value, String>) -> String {
    match result {
        Ok(value) => json!({ "id": id, "ok": value }),
        Err(error) => json!({ "id": id, "error": error }),
    }
    .to_string()
}
