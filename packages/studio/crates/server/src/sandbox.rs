//! How a user's worker is started (DECISIONS D55). A score is a program:
//! LilyPond runs the Scheme in it, which can read and write any file the
//! process can. So each worker, and the lilypond it runs, is put in a
//! bubblewrap sandbox that shows the system read-only, the user's own
//! directory read-write, and nothing of the other users or the server's data;
//! with no network and its own /tmp. `none` starts the worker as it is, for a
//! server whose users all trust each other, or for development on a Mac.
use std::path::{Path, PathBuf};
use std::process::Stdio;

use tokio::process::Command;

use crate::SandboxChoice;

/// Shown read-only in the sandbox, when present: programs, libraries, fonts, configuration.
const SYSTEM_DIRS: &[&str] = &[
    "/usr",
    "/bin",
    "/sbin",
    "/lib",
    "/lib32",
    "/lib64",
    "/etc",
    "/opt",
    "/nix/store",
];
/// The worker's PATH: lilypond's helpers (gs) are looked up on it.
const PATH: &str = "/usr/local/bin:/usr/bin:/bin";

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Sandbox {
    None,
    Bwrap { program: PathBuf },
}

/// Everything the gateway needs to start one user's worker.
#[derive(Clone, Debug)]
pub struct WorkerPlan {
    /// This program, which is also the worker.
    pub exe: PathBuf,
    /// The data directory; hidden in the sandbox.
    pub data: PathBuf,
    /// The user's directory: scores/ and studio/ inside.
    pub user_dir: PathBuf,
    pub runtime: PathBuf,
    pub lilypond: Option<PathBuf>,
    /// Further directories shown read-only.
    pub binds: Vec<PathBuf>,
}

impl Sandbox {
    /// The sandbox `choice` asks for, or why the server cannot start with it.
    pub async fn choose(choice: SandboxChoice) -> Result<Sandbox, String> {
        let bwrap = || find_on_path("bwrap");
        match choice {
            SandboxChoice::None => Ok(Sandbox::None),
            SandboxChoice::Bwrap | SandboxChoice::Auto => {
                let program = bwrap().ok_or(
                    "bubblewrap (bwrap) is not installed. Install it (apt install bubblewrap), \
                     or pass --sandbox none if every user may read every other user's scores \
                     and the server's files.",
                )?;
                let sandbox = Sandbox::Bwrap { program };
                sandbox.probe().await?;
                Ok(sandbox)
            }
        }
    }

    /// Runs `true` in an empty sandbox: user namespaces may be off, or a
    /// container may not allow them.
    async fn probe(&self) -> Result<(), String> {
        let Sandbox::Bwrap { program } = self else {
            return Ok(());
        };
        let mut command = Command::new(program);
        for dir in SYSTEM_DIRS {
            command.args(["--ro-bind-try", dir, dir]);
        }
        let output = command
            .args([
                "--unshare-all",
                "--die-with-parent",
                "--proc",
                "/proc",
                "--dev",
                "/dev",
            ])
            .args(["--", "true"])
            .stdin(Stdio::null())
            .output()
            .await
            .map_err(|error| format!("bubblewrap could not start: {error}"))?;
        if output.status.success() {
            Ok(())
        } else {
            Err(format!(
                "bubblewrap does not work here: {}It needs unprivileged user namespaces; \
                 in a container, run it with a seccomp profile that allows them.",
                String::from_utf8_lossy(&output.stderr)
            ))
        }
    }

    /// The command that starts the worker of `plan`, with stdin, stdout and
    /// stderr piped.
    pub fn command(&self, plan: &WorkerPlan) -> Command {
        let scores = plan.user_dir.join("scores");
        let profile = plan.user_dir.join("studio");
        let worker_args = [
            "worker".into(),
            "--scores".into(),
            scores.into_os_string(),
            "--profile".into(),
            profile.into_os_string(),
            "--runtime".into(),
            plan.runtime.clone().into_os_string(),
        ];
        let mut command = match self {
            Sandbox::None => {
                let mut command = Command::new(&plan.exe);
                command.args(&worker_args);
                command.env_clear();
                command.env("PATH", std::env::var_os("PATH").unwrap_or(PATH.into()));
                command.env("HOME", &plan.user_dir);
                command
            }
            Sandbox::Bwrap { program } => {
                let mut command = Command::new(program);
                command.args(bwrap_args(plan));
                command.arg("--").arg(&plan.exe).args(&worker_args);
                command.env_clear();
                command
            }
        };
        if let Some(lilypond) = &plan.lilypond {
            command.env("LILYPOND_PATH", lilypond);
        }
        command
            .current_dir(&plan.user_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        command
    }
}

/// bubblewrap's arguments for `plan`, before `--` and the worker. Order
/// matters: the data directory is hidden after the system directories that
/// may hold it are shown, and the user's own directory is shown inside it.
pub fn bwrap_args(plan: &WorkerPlan) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    let mut push = |items: &[&str]| args.extend(items.iter().map(|s| s.to_string()));
    let text = |path: &Path| path.to_string_lossy().into_owned();
    for dir in SYSTEM_DIRS {
        push(&["--ro-bind-try", dir, dir]);
    }
    // The program, the runtime, LilyPond's own directory and what the operator adds.
    let mut shown: Vec<PathBuf> = vec![plan.exe.clone(), plan.runtime.clone()];
    if let Some(lilypond) = &plan.lilypond {
        shown.push(install_dir(lilypond));
    }
    shown.extend(plan.binds.iter().cloned());
    for path in &shown {
        let path = text(path);
        push(&["--ro-bind", &path, &path]);
    }
    let data = text(&plan.data);
    let user_dir = text(&plan.user_dir);
    push(&["--tmpfs", &data, "--bind", &user_dir, &user_dir]);
    push(&[
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--tmpfs",
        "/tmp",
        "--unshare-all",
        "--die-with-parent",
        "--new-session",
        "--cap-drop",
        "ALL",
        "--chdir",
        &user_dir,
    ]);
    push(&["--setenv", "PATH", PATH, "--setenv", "HOME", &user_dir]);
    push(&["--setenv", "TMPDIR", "/tmp", "--setenv", "LANG", "C.UTF-8"]);
    args
}

/// The directory a LilyPond install lives in: `…/lilypond-2.24.4` for
/// `…/lilypond-2.24.4/bin/lilypond`, so its share/ comes along.
fn install_dir(lilypond: &Path) -> PathBuf {
    let bin = lilypond.parent().unwrap_or(lilypond);
    if bin.file_name().is_some_and(|name| name == "bin") {
        bin.parent().unwrap_or(bin).to_path_buf()
    } else {
        bin.to_path_buf()
    }
}

fn find_on_path(program: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path)
            .map(|dir| dir.join(program))
            .find(|candidate| candidate.is_file())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan() -> WorkerPlan {
        WorkerPlan {
            exe: "/opt/lily/bin/lily-studio-server".into(),
            data: "/opt/lily/data".into(),
            user_dir: "/opt/lily/data/users/abc".into(),
            runtime: "/opt/lily/runtime".into(),
            lilypond: Some("/opt/lilypond-2.24.4/bin/lilypond".into()),
            binds: vec!["/srv/fonts".into()],
        }
    }

    #[test]
    fn hides_the_data_then_shows_only_the_users_own_directory() {
        let args = bwrap_args(&plan());
        let at = |items: &[&str]| {
            args.windows(items.len())
                .position(|w| w.iter().zip(items).all(|(a, b)| a == b))
                .unwrap_or_else(|| panic!("{items:?} in {args:?}"))
        };
        let opt = at(&["--ro-bind-try", "/opt", "/opt"]);
        let hidden = at(&["--tmpfs", "/opt/lily/data"]);
        let own = at(&[
            "--bind",
            "/opt/lily/data/users/abc",
            "/opt/lily/data/users/abc",
        ]);
        assert!(opt < hidden && hidden < own);
        at(&["--ro-bind", "/opt/lilypond-2.24.4", "/opt/lilypond-2.24.4"]);
        at(&["--ro-bind", "/srv/fonts", "/srv/fonts"]);
        at(&["--unshare-all"]);
        assert!(!args.iter().any(|a| a == "--share-net"));
    }

    #[test]
    fn lilypond_brings_its_install_along() {
        assert_eq!(
            install_dir(Path::new("/opt/lilypond-2.24.4/bin/lilypond")),
            PathBuf::from("/opt/lilypond-2.24.4")
        );
        assert_eq!(
            install_dir(Path::new("/srv/lilypond")),
            PathBuf::from("/srv")
        );
    }
}
