//! Lily Studio (DECISIONS D28, D42): one window with the fixed layout of
//! renderer/index.html, the commands behind it (commands.rs), the menu
//! (menu.rs) and the native dialogs (dialogs.rs), and the scores the system
//! opens with it (opening.rs, D123), and its updates (updater.rs, D124). Compiling, watching and file access are
//! crates/engrave's, the agents crates/agents's, stem separation
//! crates/separate's (separate.rs, D112).
mod commands;
mod dialogs;
mod menu;
mod opening;
mod profile;
mod separate;
mod smoke;
mod updater;
mod video;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use tauri::utils::config::BackgroundThrottlingPolicy;
use tauri::webview::PageLoadEvent;
use tauri::{
    AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_opener::OpenerExt;

use lily_engrave::setup::{AgentSettings, AgentsSettings};
use lily_session::{Paths, Studio, StudioEvent, StudioOptions};

use crate::separate::Stems;
use crate::smoke::Smoke;

pub(crate) const WINDOW: &str = "main";

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

    // Updates come to a release build that is not the smoke test's (D124).
    let updates = !cfg!(debug_assertions) && smoke.is_none();

    let mut builder = tauri::Builder::default()
        .manage(opening::Opening::default())
        .manage(video::Video::default())
        .manage(updater::Checking::default());
    // One window per application: a second launch focuses the first, which
    // opens the scores it was given (D123). The smoke test runs beside an
    // open Lily Studio, with its own profile.
    if smoke.is_none() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            focus(app);
            opening::open(app, opening::from_args(args, Path::new(&cwd)));
        }));
    }
    if updates {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }
    let app = builder
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            // A score named on the command line; Finder's come as RunEvent::Opened.
            if smoke.is_none()
                && let Ok(cwd) = std::env::current_dir()
            {
                opening::open(app.handle(), opening::from_args(std::env::args(), &cwd));
            }
            let handle = app.handle().clone();
            let resolver = app.path();
            let paths = Paths {
                // The Electron studio's folder, so settings and chats carry over.
                data: match &smoke {
                    Some(smoke) => smoke.profile.clone(),
                    None => profile::data_folder(&resolver.data_dir()?),
                },
                documents: resolver
                    .document_dir()
                    .or_else(|_| resolver.home_dir().map(|home| home.join("Documents")))?,
                runtime: resolver.resource_dir()?.join("runtime"),
            };
            let data = paths.data.clone();
            let mut options = StudioOptions::new(paths);
            if let Some(smoke) = &smoke {
                // A stand-in for Claude Code that answers and edits without a network (D40).
                options.agents = Some(AgentsSettings {
                    claude: Some(AgentSettings {
                        path: Some(smoke.agent.to_string_lossy().into_owned()),
                        model: None,
                    }),
                    codex: None,
                });
                options.folder = Some(smoke.folder.clone());
            }
            let smoking = smoke.is_some();
            let studio = tauri::async_runtime::block_on(Studio::new(options));
            app.manage(studio.clone());
            app.manage(Smoke(smoke.clone()));
            app.manage(tauri::async_runtime::block_on(Stems::load(&data)));
            app.set_menu(menu::build(&handle, updates)?)?;
            // File › Open Recent and the welcome screen follow the recent list (D49).
            let entries = tauri::async_runtime::block_on(studio.recent.entries());
            menu::fill_recent(&handle, &entries)?;
            studio.recent.on_change({
                let handle = handle.clone();
                move |entries| {
                    let entries = entries.to_vec();
                    let app = handle.clone();
                    let filled = handle.run_on_main_thread(move || {
                        if let Err(error) = menu::fill_recent(&app, &entries) {
                            eprintln!("Open Recent: {error}");
                        }
                    });
                    if let Err(error) = filled {
                        eprintln!("Open Recent: {error}");
                    }
                    handle
                        .state::<Arc<Studio>>()
                        .send(StudioEvent::RecentChanged);
                }
            });
            app.on_menu_event(move |app, event| menu_clicked(app, event.id().as_ref()));
            create_window(&handle, smoking)?;
            if updates {
                let app = handle.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(updater::AT_LAUNCH).await;
                    updater::check(app, false).await;
                });
            }
            if let Some(timeout) = smoke.as_ref().map(smoke::timeout) {
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(timeout).await;
                    eprintln!("smoke test: did not finish within {} s", timeout.as_secs());
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
            commands::import_guitar_pro,
            commands::show_score,
            commands::set_dirty,
            commands::reveal_source,
            commands::compile_pdf,
            commands::export_pdf,
            commands::export_midi,
            commands::export_garageband,
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
            commands::chat_image,
            commands::chat_answer,
            commands::chat_stop,
            commands::chat_delete,
            commands::playback_setup,
            commands::set_playback_setup,
            commands::recent_list,
            commands::open_recent,
            commands::forget_recent,
            commands::clear_recent,
            separate::separation_status,
            separate::separation_models,
            separate::choose_song,
            separate::separate,
            separate::separation_cancel,
            separate::mix_stems,
            separate::reveal_in_finder,
            separate::new_score_for_stem,
            separate::attach_stem,
            separate::choose_audio,
            separate::transcribe_stem,
            separate::detect_tempo,
            separate::detect_sung,
            separate::separations,
            separate::open_separation,
            separate::choose_separation,
            separate::forget_separation,
            video::video_start,
            video::video_frame,
            video::video_audio,
            video::video_finish,
            video::video_cancel,
            smoke::smoke_folder,
            smoke::smoke_read,
            smoke::smoke_read_bytes,
            smoke::smoke_write,
            smoke::smoke_list,
            smoke::smoke_menu,
            smoke::smoke_drop,
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

    app.run(|app, event| match event {
        // Stop lilypond, the agents, a separation and a transcription, and
        // delete the pages in the temp directory before exiting; the smoke
        // test's folder goes too.
        RunEvent::Exit => {
            app.state::<Stems>().separator.cancel();
            app.state::<Stems>().transcriber.cancel();
            tauri::async_runtime::block_on(app.state::<video::Video>().cancel());
            let studio = app.state::<Arc<Studio>>().inner().clone();
            tauri::async_runtime::block_on(studio.dispose());
            if let Some(smoke) = &app.state::<Smoke>().0 {
                smoke::clean(smoke);
            }
        }
        // Finder opens scores with the studio, at launch or while it runs (D123).
        #[cfg(target_os = "macos")]
        RunEvent::Opened { urls } => opening::open(app, opening::from_urls(&urls)),
        _ => {}
    });
}

/// Brings the window forward, out of the Dock if it was minimized.
pub(crate) fn focus(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(WINDOW) {
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
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
            if studio.dirty.load(Ordering::SeqCst) && !smoke {
                api.prevent_close();
                tauri::async_runtime::spawn(confirm_close(guarded.clone(), studio));
            }
        }
    });
    Ok(window)
}

async fn confirm_close(window: WebviewWindow, studio: Arc<Studio>) {
    if edits_settled(&window, &studio).await {
        studio.dirty.store(false, Ordering::SeqCst);
        let _ = window.close();
    }
}

/// Save, Don't Save or Cancel, as a Mac user expects when closing with edits:
/// true once they are saved or dropped, false when cancelled or a save failed.
pub(crate) async fn edits_settled(window: &WebviewWindow, studio: &Studio) -> bool {
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
            // A save failed, and the page has said why.
            became_clean(studio, Duration::from_secs(10)).await
        }
        Ok(2) => true,
        _ => false,
    }
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
    } else if let Some(path) = id.strip_prefix(menu::RECENT_PREFIX) {
        app.state::<Arc<Studio>>().send(StudioEvent::OpenRecent {
            path: path.to_string(),
        });
    } else if id == menu::RECENT_CLEAR {
        let studio = app.state::<Arc<Studio>>().inner().clone();
        tauri::async_runtime::spawn(async move {
            if let Err(error) = studio.recent.clear().await {
                eprintln!("{error}");
            }
        });
    } else if id == updater::CHECK {
        tauri::async_runtime::spawn(updater::check(app.clone(), true));
    } else if id == menu::LEARN
        && let Some(url) = lily_engrave::setup::setup_link("learn")
    {
        let _ = app.opener().open_url(url, None::<&str>);
    }
}
