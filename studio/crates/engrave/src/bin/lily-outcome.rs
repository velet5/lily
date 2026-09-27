//! `lily-outcome <root.ly> [--runtime <dir>]`: compiles a score once, as Lily
//! Studio does (acceleration off), and prints the finished `CompileOutcome` as
//! JSON on stdout. Exit code 0 even when the score has errors; 2 when lilypond
//! did not run. The renderer's tests use it to get real outcomes.

use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;

use futures::FutureExt;
use lily_engrave::{
    Acceleration, CompileService, CompileServiceOptions, CompileState, SearchPath, StudioCompiler,
    StudioCompilerOptions, paths, setup,
};

const USAGE: &str = "usage: lily-outcome <root.ly> [--runtime <dir>]";

#[tokio::main]
async fn main() -> ExitCode {
    let mut root: Option<PathBuf> = None;
    let mut runtime: Option<PathBuf> = None;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--runtime" => match args.next() {
                Some(dir) => runtime = Some(paths::resolve(dir)),
                None => return usage(),
            },
            "-h" | "--help" => {
                println!("{USAGE}");
                return ExitCode::SUCCESS;
            }
            _ if root.is_none() => root = Some(paths::resolve(arg)),
            _ => return usage(),
        }
    }
    let Some(root) = root else { return usage() };

    let search_path = SearchPath::new(setup::search_path(
        std::env::var("PATH").ok().as_deref(),
        None,
    ));
    let service = CompileService::new(CompileServiceOptions {
        tmp_root: None,
        runtime_dir: runtime,
        search_path,
    });
    let lilypond = std::env::var("LILYPOND_PATH")
        .ok()
        .filter(|p| !p.is_empty());
    let mut options = StudioCompilerOptions::new(
        Arc::new(service),
        || async { Vec::new() }.boxed(),
        |_event| {},
    );
    options.lilypond_path = Some(Arc::new(move || lilypond.clone()));
    options.acceleration = Acceleration::Off;
    let studio = StudioCompiler::new(options);

    let outcome = studio.compile(&root).await;
    let code = match &outcome {
        Some(outcome) => {
            match serde_json::to_string(outcome) {
                Ok(json) => println!("{json}"),
                Err(error) => {
                    eprintln!("lily-outcome: {error}");
                    return ExitCode::from(2);
                }
            }
            if matches!(
                outcome.state,
                CompileState::NoLilypond | CompileState::Error
            ) {
                if let Some(message) = &outcome.message {
                    eprintln!("lily-outcome: {message}");
                }
                ExitCode::from(2)
            } else {
                ExitCode::SUCCESS
            }
        }
        None => {
            eprintln!("lily-outcome: the compile was cancelled");
            ExitCode::from(2)
        }
    };
    // The outcome holds the page texts; the run's directory can go.
    studio.dispose().await;
    code
}

fn usage() -> ExitCode {
    eprintln!("{USAGE}");
    ExitCode::from(2)
}
