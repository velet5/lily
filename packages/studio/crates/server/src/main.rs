//! Lily Studio on the web (DECISIONS D55): `serve` runs the gateway — the
//! accounts, the page and its socket — and one worker per signed-in user,
//! sandboxed, that does what the app's main process does for its window;
//! `user` manages the accounts; `worker` is the worker itself, started only
//! by the gateway.
mod gateway;
mod login;
mod sandbox;
mod sessions;
mod users;
mod worker;
mod workers;

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Args, Parser, Subcommand, ValueEnum};

#[derive(Parser)]
#[command(name = "lily-studio-server", version, about = "Lily Studio on the web")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Serves Lily Studio to signed-in users.
    Serve(ServeArgs),
    /// Adds, removes and lists accounts.
    #[command(subcommand)]
    User(UserCommand),
    /// One user's studio, on stdin and stdout; started by `serve`.
    #[command(hide = true)]
    Worker(worker::WorkerArgs),
}

#[derive(Args, Clone)]
pub struct ServeArgs {
    /// Where to listen; put a proxy that terminates HTTPS in front of it.
    #[arg(long, default_value = "127.0.0.1:8080")]
    pub listen: SocketAddr,
    /// The accounts, the sessions and every user's scores.
    #[arg(long, default_value = "server-data")]
    pub data: PathBuf,
    /// The page, as `node esbuild.mjs --site` builds it.
    #[arg(long, default_value = "dist/site")]
    pub site: PathBuf,
    /// @lily/common's runtime/, as esbuild.mjs copies it.
    #[arg(long, default_value = "dist/runtime")]
    pub runtime: PathBuf,
    /// The lilypond program; else the first on PATH or in the usual places.
    #[arg(long)]
    pub lilypond: Option<PathBuf>,
    /// How each user's worker is kept from the others' scores and the server's files.
    #[arg(long, value_enum, default_value_t = SandboxChoice::Auto)]
    pub sandbox: SandboxChoice,
    /// A further directory the sandbox shows, read-only: fonts, a LilyPond outside /usr and /opt.
    #[arg(long = "sandbox-bind", value_name = "DIR")]
    pub sandbox_binds: Vec<PathBuf>,
    /// Lets anyone create an account on the sign-in page.
    #[arg(long)]
    pub signup: bool,
    /// Marks the session cookie Secure; set it when the server is reached over HTTPS.
    #[arg(long)]
    pub secure_cookies: bool,
    /// A worker without a page is stopped after this many minutes.
    #[arg(long, default_value_t = 15)]
    pub idle_minutes: u64,
    /// Workers running at once; a user beyond them is asked to come back later.
    #[arg(long, default_value_t = 32)]
    pub max_workers: usize,
}

/// `auto` is bubblewrap when it is installed and works, and refuses to start otherwise.
#[derive(Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum SandboxChoice {
    Auto,
    Bwrap,
    /// No sandbox: every user can reach every file the server can. Only for users you trust.
    None,
}

#[derive(Subcommand)]
enum UserCommand {
    /// Adds an account; the password is asked for, or read from stdin.
    Add {
        name: String,
        #[arg(long, default_value = "server-data")]
        data: PathBuf,
        /// Reads the password from the first line of stdin.
        #[arg(long)]
        password_stdin: bool,
    },
    /// Sets a new password.
    Password {
        name: String,
        #[arg(long, default_value = "server-data")]
        data: PathBuf,
        #[arg(long)]
        password_stdin: bool,
    },
    /// Removes an account and signs it out; its scores stay on disk.
    Remove {
        name: String,
        #[arg(long, default_value = "server-data")]
        data: PathBuf,
    },
    /// Lists the accounts.
    List {
        #[arg(long, default_value = "server-data")]
        data: PathBuf,
    },
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let runtime = match tokio::runtime::Runtime::new() {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("lily-studio-server: {error}");
            return ExitCode::FAILURE;
        }
    };
    let result = match cli.command {
        Command::Serve(args) => runtime.block_on(gateway::serve(args)),
        Command::User(command) => runtime.block_on(user(command)),
        Command::Worker(args) => return runtime.block_on(worker::run(args)),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("lily-studio-server: {error}");
            ExitCode::FAILURE
        }
    }
}

async fn user(command: UserCommand) -> Result<(), String> {
    match command {
        UserCommand::Add {
            name,
            data,
            password_stdin,
        } => {
            let password = read_password(password_stdin)?;
            let store = users::UserStore::open(&data).await?;
            let user = store.add(&name, &password).await?;
            println!(
                "Added {}; their scores go in {}",
                user.name,
                users::scores_dir(&data, &user.id).display()
            );
        }
        UserCommand::Password {
            name,
            data,
            password_stdin,
        } => {
            let password = read_password(password_stdin)?;
            let store = users::UserStore::open(&data).await?;
            let user = store.set_password(&name, &password).await?;
            sessions::SessionStore::open(&data)
                .await?
                .remove_user(&user.id)
                .await?;
            println!("Set the password of {name} and signed them out");
        }
        UserCommand::Remove { name, data } => {
            let store = users::UserStore::open(&data).await?;
            let user = store.remove(&name).await?;
            sessions::SessionStore::open(&data)
                .await?
                .remove_user(&user.id)
                .await?;
            println!(
                "Removed {name}; their scores are still in {}",
                users::user_dir(&data, &user.id).display()
            );
        }
        UserCommand::List { data } => {
            let store = users::UserStore::open(&data).await?;
            for user in store.list().await {
                println!("{}\t{}", user.name, user.id);
            }
        }
    }
    Ok(())
}

/// The password from stdin's first line, or asked for twice on the terminal.
fn read_password(from_stdin: bool) -> Result<String, String> {
    if from_stdin {
        let mut line = String::new();
        std::io::stdin()
            .read_line(&mut line)
            .map_err(|error| error.to_string())?;
        return Ok(line.trim_end_matches(['\r', '\n']).to_string());
    }
    let first = rpassword::prompt_password("Password: ").map_err(|error| error.to_string())?;
    let again = rpassword::prompt_password("Again: ").map_err(|error| error.to_string())?;
    if again != first {
        return Err("The two passwords differ.".into());
    }
    Ok(first)
}
