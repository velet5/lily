//! The gateway (DECISIONS D55): the sign-in page, the page of the studio and
//! its files, and the socket that joins a signed-in page to its user's
//! worker. It reads and writes the accounts and sessions; it never touches
//! a user's scores, which only their worker can reach.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::Router;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Form, Query, State};
use axum::http::header::{self, HeaderMap, HeaderValue};
use axum::http::{Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{Html, IntoResponse, Redirect, Response};
use axum::routing::get;
use futures::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::json;
use tower_http::services::ServeDir;

use crate::login::{self, Form as LoginForm, LoginPage};
use crate::sandbox::Sandbox;
use crate::sessions::{LIFETIME, SessionStore};
use crate::users::{User, UserStore, check_name, check_password};
use crate::workers::{Connection, ToPage, Workers, WorkersOptions};
use crate::{SandboxChoice, ServeArgs};

const COOKIE: &str = "lily_session";
/// A message of the page; an upload is the largest (worker/commands.rs's MAX_UPLOAD, in base64).
const MAX_MESSAGE: usize = 4 * 1024 * 1024;
/// Failed sign-ins of a name before it must wait.
const ATTEMPTS: u32 = 5;
const ATTEMPT_PAUSE: Duration = Duration::from_secs(60);
/// The socket is pinged this often, so proxies keep it open.
const PING: Duration = Duration::from_secs(25);

pub struct Gateway {
    site: PathBuf,
    signup: bool,
    secure_cookies: bool,
    users: UserStore,
    sessions: SessionStore,
    workers: Arc<Workers>,
    /// Failed sign-ins by name: how many, and the last.
    failures: Mutex<HashMap<String, (u32, Instant)>>,
}

type Shared = State<Arc<Gateway>>;

/// `path`, absolute; it need not exist yet.
fn absolute(path: &Path) -> Result<PathBuf, String> {
    let path = std::path::absolute(path).map_err(|error| format!("{}: {error}", path.display()))?;
    Ok(path.canonicalize().unwrap_or(path))
}

pub async fn serve(args: ServeArgs) -> Result<(), String> {
    let site = absolute(&args.site)?;
    let runtime = absolute(&args.runtime)?;
    if !site.join("index.html").is_file() {
        return Err(format!(
            "{} has no index.html; build the page with `node esbuild.mjs --site` first.",
            site.display()
        ));
    }
    if !runtime.join("timing.ly").is_file() {
        return Err(format!("{} has no timing.ly.", runtime.display()));
    }
    tokio::fs::create_dir_all(&args.data)
        .await
        .map_err(|error| format!("{}: {error}", args.data.display()))?;
    let data = absolute(&args.data)?;
    let sandbox = Sandbox::choose(args.sandbox).await?;
    if args.sandbox == SandboxChoice::None {
        eprintln!(
            "Warning: no sandbox. A score can run programs, so every user can read and change \
             every other user's scores and the files of the server's account."
        );
    }
    let exe = std::env::current_exe().map_err(|error| error.to_string())?;
    let workers = Workers::new(WorkersOptions {
        sandbox,
        exe,
        data: data.clone(),
        runtime,
        lilypond: args.lilypond.as_deref().map(absolute).transpose()?,
        binds: args
            .sandbox_binds
            .iter()
            .map(|dir| absolute(dir))
            .collect::<Result<_, _>>()?,
        idle: Duration::from_secs(args.idle_minutes.max(1) * 60),
        max: args.max_workers.max(1),
    });
    let gateway = Arc::new(Gateway {
        site,
        signup: args.signup,
        secure_cookies: args.secure_cookies,
        users: UserStore::open(&data).await?,
        sessions: SessionStore::open(&data).await?,
        workers: workers.clone(),
        failures: Mutex::new(HashMap::new()),
    });
    if gateway.users.list().await.is_empty() && !args.signup {
        eprintln!(
            "There are no accounts yet: add one with `lily-studio-server user add <name> --data {}`, \
             or start with --signup.",
            data.display()
        );
    }
    let listener = tokio::net::TcpListener::bind(args.listen)
        .await
        .map_err(|error| format!("{}: {error}", args.listen))?;
    eprintln!("Lily Studio is at http://{}", args.listen);
    axum::serve(listener, router(gateway))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .map_err(|error| error.to_string())?;
    workers.shut_down_all();
    // Long enough for the workers to stop lilypond.
    tokio::time::sleep(Duration::from_millis(500)).await;
    Ok(())
}

pub fn router(gateway: Arc<Gateway>) -> Router {
    let files = ServeDir::new(&gateway.site);
    Router::new()
        .route("/", get(index))
        .route("/index.html", get(|| async { Redirect::to("/") }))
        .route("/login", get(login_page).post(login))
        .route("/signup", axum::routing::post(signup))
        .route("/logout", axum::routing::post(logout))
        .route("/ws", get(socket))
        .fallback_service(files)
        .layer(middleware::from_fn(guard))
        .with_state(gateway)
}

/// What every answer carries, and the check every form and the socket pass:
/// they must come from this site's own pages.
async fn guard(request: axum::extract::Request, next: Next) -> Response {
    let checked = request.method() == Method::POST || request.uri().path() == "/ws";
    if checked && !same_origin(request.headers()) {
        return (StatusCode::FORBIDDEN, "Forbidden: from another site.").into_response();
    }
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("same-origin"),
    );
    headers.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    headers
        .entry(header::CONTENT_SECURITY_POLICY)
        .or_insert(HeaderValue::from_static(
            "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; \
             worker-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; \
             frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        ));
    response
}

/// True when the request's Origin, or else its Referer, is this host.
fn same_origin(headers: &HeaderMap) -> bool {
    let Some(host) = headers.get(header::HOST).and_then(|h| h.to_str().ok()) else {
        return false;
    };
    let from = headers
        .get(header::ORIGIN)
        .or_else(|| headers.get(header::REFERER))
        .and_then(|h| h.to_str().ok());
    from.and_then(|from| from.split_once("://"))
        .map(|(_, rest)| rest.split('/').next().unwrap_or(""))
        .is_some_and(|origin_host| origin_host.eq_ignore_ascii_case(host))
}

fn cookie(headers: &HeaderMap) -> Option<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(name, _)| *name == COOKIE)
        .map(|(_, value)| value.to_string())
}

impl Gateway {
    /// The signed-in user of a request.
    async fn user(&self, headers: &HeaderMap) -> Option<User> {
        let token = cookie(headers)?;
        let id = self.sessions.user(&token).await?;
        self.users.by_id(&id).await
    }

    fn set_cookie(&self, token: &str, max_age: u64) -> HeaderValue {
        let secure = if self.secure_cookies { "; Secure" } else { "" };
        HeaderValue::from_str(&format!(
            "{COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age}{secure}"
        ))
        .expect("a cookie of hex digits")
    }

    /// Signs `user` in and sends them to the studio.
    async fn signed_in(&self, user: &User) -> Response {
        match self.sessions.create(&user.id).await {
            Ok(token) => {
                let mut response = Redirect::to("/").into_response();
                response.headers_mut().insert(
                    header::SET_COOKIE,
                    self.set_cookie(&token, LIFETIME.as_secs()),
                );
                response
            }
            Err(error) => {
                eprintln!("sessions: {error}");
                self.page(
                    Some("You could not be signed in. Try again."),
                    LoginForm::SignIn,
                    "",
                )
            }
        }
    }

    fn page(&self, message: Option<&str>, form: LoginForm, name: &str) -> Response {
        let status = if message.is_some() {
            StatusCode::UNAUTHORIZED
        } else {
            StatusCode::OK
        };
        let mut response = (
            status,
            Html(login::render(&LoginPage {
                message,
                form,
                signup: self.signup,
                name,
            })),
        )
            .into_response();
        response.headers_mut().insert(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static(
                "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; \
                 frame-ancestors 'none'; base-uri 'none'",
            ),
        );
        response
    }

    /// Whether `name` may try again now, after failed sign-ins.
    fn may_try(&self, name: &str) -> bool {
        let failures = self.failures.lock().unwrap_or_else(|p| p.into_inner());
        !failures
            .get(name)
            .is_some_and(|(count, last)| *count >= ATTEMPTS && last.elapsed() < ATTEMPT_PAUSE)
    }

    fn failed(&self, name: &str) {
        let mut failures = self.failures.lock().unwrap_or_else(|p| p.into_inner());
        failures.retain(|_, (_, last)| last.elapsed() < ATTEMPT_PAUSE * 10);
        let entry = failures
            .entry(name.to_string())
            .or_insert((0, Instant::now()));
        // A pause served starts the count again.
        if entry.0 >= ATTEMPTS {
            entry.0 = 0;
        }
        entry.0 += 1;
        entry.1 = Instant::now();
    }
}

async fn index(State(gateway): Shared, headers: HeaderMap) -> Response {
    if gateway.user(&headers).await.is_none() {
        return Redirect::to("/login").into_response();
    }
    match tokio::fs::read_to_string(gateway.site.join("index.html")).await {
        Ok(page) => {
            let mut response = Html(page).into_response();
            response
                .headers_mut()
                .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            response
        }
        Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response(),
    }
}

#[derive(Deserialize)]
struct LoginQuery {
    signup: Option<String>,
}

async fn login_page(
    State(gateway): Shared,
    headers: HeaderMap,
    Query(query): Query<LoginQuery>,
) -> Response {
    if gateway.user(&headers).await.is_some() {
        return Redirect::to("/").into_response();
    }
    let form = if query.signup.is_some() {
        LoginForm::SignUp
    } else {
        LoginForm::SignIn
    };
    gateway.page(None, form, "")
}

#[derive(Deserialize)]
struct Credentials {
    name: String,
    password: String,
    #[serde(default)]
    again: String,
}

async fn login(State(gateway): Shared, Form(form): Form<Credentials>) -> Response {
    let name = form.name.trim().to_lowercase();
    if !gateway.may_try(&name) {
        return gateway.page(
            Some("Too many wrong passwords. Wait a minute, then try again."),
            LoginForm::SignIn,
            &name,
        );
    }
    match gateway.users.verify(&name, &form.password).await {
        Some(user) => gateway.signed_in(&user).await,
        None => {
            gateway.failed(&name);
            gateway.page(
                Some("That name and password do not match an account."),
                LoginForm::SignIn,
                &name,
            )
        }
    }
}

async fn signup(State(gateway): Shared, Form(form): Form<Credentials>) -> Response {
    if !gateway.signup {
        return (StatusCode::NOT_FOUND, "Not found").into_response();
    }
    let name = form.name.trim().to_lowercase();
    let checked = check_name(&name)
        .and_then(|()| check_password(&form.password))
        .and_then(|()| match form.again == form.password {
            true => Ok(()),
            false => Err("The two passwords differ.".to_string()),
        });
    let added = match checked {
        Ok(()) => gateway.users.add(&name, &form.password).await,
        Err(error) => Err(error),
    };
    match added {
        Ok(user) => {
            eprintln!("[{name}] created an account");
            gateway.signed_in(&user).await
        }
        Err(error) => gateway.page(Some(&error), LoginForm::SignUp, &name),
    }
}

async fn logout(State(gateway): Shared, headers: HeaderMap) -> Response {
    if let Some(token) = cookie(&headers)
        && let Err(error) = gateway.sessions.remove(&token).await
    {
        eprintln!("sessions: {error}");
    }
    let mut response = Redirect::to("/login").into_response();
    response
        .headers_mut()
        .insert(header::SET_COOKIE, gateway.set_cookie("", 0));
    response
}

async fn socket(State(gateway): Shared, headers: HeaderMap, upgrade: WebSocketUpgrade) -> Response {
    let Some(user) = gateway.user(&headers).await else {
        return (StatusCode::UNAUTHORIZED, "Sign in first.").into_response();
    };
    upgrade
        .max_message_size(MAX_MESSAGE)
        .on_upgrade(move |socket| relay(gateway, user, socket))
}

/// Joins the page to its user's worker until either ends.
async fn relay(gateway: Arc<Gateway>, user: User, socket: WebSocket) {
    let (mut to_page, mut from_page) = socket.split();
    let Connection {
        worker,
        page,
        mut out,
    } = match gateway.workers.connect(&user).await {
        Ok(connection) => connection,
        Err(error) => {
            let _ = to_page
                .send(Message::Text(json!({ "closed": error }).to_string().into()))
                .await;
            let _ = to_page.close().await;
            return;
        }
    };
    let hello = json!({ "hello": { "user": user.name, "instance": worker.instance } });
    if to_page
        .send(Message::Text(hello.to_string().into()))
        .await
        .is_err()
    {
        gateway.workers.disconnect(&worker, page);
        return;
    }
    let writer = tokio::spawn(async move {
        let mut ping = tokio::time::interval(PING);
        ping.tick().await;
        loop {
            tokio::select! {
                next = out.recv() => match next {
                    Some(ToPage::Line(line)) => {
                        if to_page.send(Message::Text(line.into())).await.is_err() {
                            break;
                        }
                    }
                    Some(ToPage::End(line)) => {
                        let _ = to_page.send(Message::Text(line.into())).await;
                        let _ = to_page
                            .send(Message::Close(Some(CloseFrame { code: 1000, reason: "".into() })))
                            .await;
                        break;
                    }
                    None => break,
                },
                _ = ping.tick() => {
                    if to_page.send(Message::Ping(Vec::new().into())).await.is_err() {
                        break;
                    }
                }
            }
        }
    });
    while let Some(Ok(message)) = from_page.next().await {
        match message {
            // One call per line for the worker; JSON never needs a raw newline.
            Message::Text(text) if !text.contains('\n') => worker.send(text.to_string()),
            Message::Close(_) => break,
            _ => {}
        }
        if writer.is_finished() {
            break;
        }
    }
    gateway.workers.disconnect(&worker, page);
    writer.abort();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.append(*name, HeaderValue::from_str(value).unwrap());
        }
        map
    }

    #[test]
    fn same_origin_compares_the_origin_or_referer_with_the_host() {
        assert!(same_origin(&headers(&[
            ("host", "lily.example"),
            ("origin", "https://lily.example")
        ])));
        assert!(same_origin(&headers(&[
            ("host", "localhost:8080"),
            ("referer", "http://localhost:8080/login")
        ])));
        assert!(!same_origin(&headers(&[
            ("host", "lily.example"),
            ("origin", "https://evil.example")
        ])));
        assert!(!same_origin(&headers(&[
            ("host", "lily.example"),
            ("origin", "https://lily.example.evil")
        ])));
        assert!(!same_origin(&headers(&[("host", "lily.example")])));
    }

    #[test]
    fn finds_the_session_among_cookies() {
        let map = headers(&[("cookie", "a=1; lily_session=abc; b=2")]);
        assert_eq!(cookie(&map).as_deref(), Some("abc"));
        assert_eq!(cookie(&headers(&[("cookie", "lily_sessionx=1")])), None);
    }
}
