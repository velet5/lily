//! Lily Studio (DECISIONS D28, D42): one window with the fixed layout of
//! renderer/index.html, the commands behind it (commands.rs), the menu
//! (menu.rs) and the native dialogs (dialogs.rs). Compiling, watching and
//! file access are crates/engrave's, the agents crates/agents's.
mod commands;
mod dialogs;
mod menu;
mod smoke;
mod state;

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use tauri::utils::config::BackgroundThrottlingPolicy;
use tauri::webview::PageLoadEvent;
use tauri::{
    AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_opener::OpenerExt;

use crate::state::{Paths, Studio, StudioEvent};

const WINDOW: &str = "main";

pub fn run() {
    // Run by `npm run test:smoke`: drive the window once, print a report, exit.
    let smoke_test = std::env::args().any(|arg| arg == "--smoke-test");
    let smoke = match smoke_test.then(smoke::prepare).transpose() {
        Ok(smoke) => smoke,
        Err(error) => {
            eprintln!("smoke test: cannot prepare its folder: {error}");
            std::process::exit(1);
        }
    };

    let mut builder = tauri::Builder::default();
    // One window per application: a second launch focuses the first. The
    // smoke test runs beside an open Lily Studio, with its own profile.
    if smoke.is_none() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window(WINDOW) {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }));
    }
    let app = builder
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            let handle = app.handle().clone();
            let resolver = app.path();
            let paths = Paths {
                // The Electron studio's folder, so settings and chats carry over.
                data: match &smoke {
                    Some(smoke) => smoke.profile.clone(),
                    None => resolver.data_dir()?.join("Lily Studio"),
                },
                documents: resolver
                    .document_dir()
                    .or_else(|_| resolver.home_dir().map(|home| home.join("Documents")))?,
                runtime: resolver.resource_dir()?.join("runtime"),
            };
            let studio = tauri::async_runtime::block_on(Studio::new(paths, smoke.clone()));
            app.manage(studio.clone());
            app.set_menu(menu::build(&handle)?)?;
            app.on_menu_event(move |app, event| menu_clicked(app, event.id().as_ref()));
            create_window(&handle, studio.smoke.is_some())?;
            if studio.smoke.is_some() {
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(smoke::TIMEOUT).await;
                    eprintln!(
                        "smoke test: did not finish within {} s",
                        smoke::TIMEOUT.as_secs()
                    );
                    handle.exit(1);
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::subscribe,
            commands::templates,
            commands::open_folder,
            commands::open_file,
            commands::list_folder,
            commands::read_file,
            commands::save_file,
            commands::new_score,
            commands::show_score,
            commands::set_dirty,
            commands::reveal_source,
            commands::compile_pdf,
            commands::export_pdf,
            commands::confirm_reload,
            commands::edited,
            commands::set_live,
            commands::lilypond_status,
            commands::choose_lilypond,
            commands::open_link,
            commands::open_sample,
            commands::agent_status,
            commands::choose_agent,
            commands::set_agent_model,
            commands::chat_list,
            commands::chat_get,
            commands::chat_send,
            commands::chat_stop,
            commands::chat_delete,
            smoke::smoke_folder,
            smoke::smoke_read,
            smoke::smoke_write,
            smoke::smoke_list,
            smoke::smoke_menu,
            smoke::smoke_log,
            smoke::smoke_done,
        ])
        .build(tauri::generate_context!());
    let app = match app {
        Ok(app) => app,
        Err(error) => {
            eprintln!("Lily Studio could not start: {error}");
            std::process::exit(1);
        }
    };

    app.run(|app, event| {
        // Stop lilypond and the agents and delete the pages in the temp
        // directory before exiting; the smoke test's folder goes too.
        if let RunEvent::Exit = event {
            let studio = app.state::<Arc<Studio>>().inner().clone();
            tauri::async_runtime::block_on(studio.dispose());
            if let Some(smoke) = &studio.smoke {
                smoke::clean(smoke);
            }
        }
    });
}

fn create_window(app: &AppHandle, smoke: bool) -> tauri::Result<WebviewWindow> {
    let mut builder =
        WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::App(PathBuf::from("index.html")));
    if smoke {
        builder = builder.initialization_script(smoke::FRAMES);
    }
    let window = builder
        .title("Lily Studio")
        .inner_size(1280.0, 800.0)
        .min_inner_size(900.0, 560.0)
        // Shown once the page has loaded, so it never flashes empty.
        .visible(false)
        // The page never navigates; links out go through open_link.
        // WebKit throttles a hidden or covered page's timers and frames; the
        // smoke test's hidden window must run at full speed.
        .background_throttling(if smoke {
            BackgroundThrottlingPolicy::Disabled
        } else {
            BackgroundThrottlingPolicy::Suspend
        })
        .on_navigation(|url| url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost"))
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .on_page_load(move |window, payload| {
            if payload.event() != PageLoadEvent::Finished {
                return;
            }
            // The smoke test's window stays hidden, out of the way of whatever is on screen.
            if !smoke {
                let _ = window.show();
            }
            if smoke && let Err(error) = window.eval(smoke::LOAD_DRIVER) {
                eprintln!("smoke test: cannot load its driver: {error}");
                window.app_handle().exit(1);
            }
        })
        .build()?;
    let guarded = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            let studio = guarded.state::<Arc<Studio>>().inner().clone();
            if studio.dirty.load(Ordering::SeqCst) && studio.smoke.is_none() {
                api.prevent_close();
                tauri::async_runtime::spawn(confirm_close(guarded.clone(), studio));
            }
        }
    });
    Ok(window)
}

/// Save, Don't Save or Cancel, as a Mac user expects when closing with edits.
async fn confirm_close(window: WebviewWindow, studio: Arc<Studio>) {
    let answer = dialogs::alert(
        window.app_handle(),
        dialogs::Alert {
            message: "Do you want to save the changes you made?".into(),
            detail: "Your changes will be lost if you don't save them.".into(),
            buttons: vec!["Save".into(), "Cancel".into(), "Don't Save".into()],
        },
    )
    .await;
    match answer {
        Ok(0) => {
            studio.send(StudioEvent::Command {
                command: "save-all".into(),
            });
            // A save failed, and the page has said why: the window stays.
            if !became_clean(&studio, Duration::from_secs(10)).await {
                return;
            }
        }
        Ok(2) => {}
        _ => return,
    }
    studio.dirty.store(false, Ordering::SeqCst);
    let _ = window.close();
}

/// True once the page reports no unsaved changes, false after `limit`.
async fn became_clean(studio: &Studio, limit: Duration) -> bool {
    let started = Instant::now();
    while studio.dirty.load(Ordering::SeqCst) {
        if started.elapsed() > limit {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    true
}

fn menu_clicked(app: &AppHandle, id: &str) {
    if menu::COMMANDS.contains(&id) {
        app.state::<Arc<Studio>>().send(StudioEvent::Command {
            command: id.to_string(),
        });
    } else if id == menu::LEARN
        && let Some(url) = lily_engrave::setup::setup_link("learn")
    {
        let _ = app.opener().open_url(url, None::<&str>);
    }
}
