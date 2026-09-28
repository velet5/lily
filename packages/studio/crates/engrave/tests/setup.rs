//! From studio/test/lilypondSetup.test.ts and the settings part of agents.test.ts.

mod common;

use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;

use common::Scratch;
use futures::FutureExt;
use lily_engrave::locate::BinarySource;
use lily_engrave::setup::{
    AgentSettings, AgentsSettings, DetectOptions, LilyPondState, SETUP_LINKS, Settings,
    choice_path, compare_versions, detect_lilypond, parse_version, read_settings, search_path,
    setup_link, write_settings,
};

/// A directory with an executable `lilypond` that only has to exist; `version` answers for it.
async fn bin() -> (Scratch, PathBuf) {
    let s = Scratch::new("lily-studio-setup-");
    let bin = s.at("LilyPond/bin");
    let file = s.write("LilyPond/bin/lilypond", "#!/bin/sh\n").await;
    tokio::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755))
        .await
        .unwrap();
    (s, bin)
}

fn answers(output: &'static str) -> Option<lily_engrave::setup::VersionFn> {
    Some(Box::new(move |_| {
        async move { Ok(output.to_owned()) }.boxed()
    }))
}

fn nowhere() -> DetectOptions {
    DetectOptions {
        path: String::new(),
        well_known_dirs: Some(vec![]),
        ..Default::default()
    }
}

#[tokio::test]
async fn ready_when_found_and_new_enough() {
    let (_s, bin) = bin().await;
    let status = detect_lilypond(DetectOptions {
        well_known_dirs: Some(vec![bin.clone()]),
        version: answers("GNU LilyPond 2.26.0 (running Guile 3.0)\n"),
        ..nowhere()
    })
    .await;
    assert_eq!(status.state, LilyPondState::Ready);
    assert_eq!(status.version.as_deref(), Some("2.26.0"));
    assert_eq!(status.path, Some(bin.join("lilypond")));
    assert_eq!(status.source, Some(BinarySource::WellKnown));
    assert_eq!(status.message, "LilyPond 2.26.0 is ready.");
    let json = serde_json::to_value(&status).unwrap();
    assert_eq!(json["state"], "ready");
    assert_eq!(json["source"], "well-known");
    assert!(json.get("chosen").is_none());
}

#[tokio::test]
async fn missing_in_plain_words() {
    let status = detect_lilypond(nowhere()).await;
    assert_eq!(status.state, LilyPondState::Missing);
    assert!(status.message.contains("not installed on this Mac"));
    assert_eq!(status.path, None);
    assert_eq!(
        serde_json::to_value(&status).unwrap(),
        serde_json::json!({ "state": "missing", "message": status.message })
    );
}

#[tokio::test]
async fn a_chosen_path_that_went_away_is_named() {
    let (s, _) = bin().await;
    let gone = s.at("gone").display().to_string();
    let status = detect_lilypond(DetectOptions {
        configured_path: Some(gone.clone()),
        ..nowhere()
    })
    .await;
    assert_eq!(status.state, LilyPondState::Missing);
    assert_eq!(status.chosen, Some(gone));
    assert!(status.message.contains("could not be found any more"));
}

#[tokio::test]
async fn a_chosen_install_folder_is_looked_into() {
    let (_s, bin) = bin().await;
    let status = detect_lilypond(DetectOptions {
        configured_path: Some(bin.parent().unwrap().display().to_string()),
        version: answers("GNU LilyPond 2.24.4\n"),
        ..nowhere()
    })
    .await;
    assert_eq!(
        (status.state, status.source, status.version.as_deref()),
        (
            LilyPondState::Ready,
            Some(BinarySource::Setting),
            Some("2.24.4")
        )
    );
}

#[tokio::test]
async fn too_old_broken_or_not_lilypond() {
    let (_s, bin) = bin().await;
    let found = || DetectOptions {
        well_known_dirs: Some(vec![bin.clone()]),
        ..nowhere()
    };
    let old = detect_lilypond(DetectOptions {
        version: answers("GNU LilyPond 2.22.2\n"),
        ..found()
    })
    .await;
    assert_eq!(
        (old.state, old.version.as_deref()),
        (LilyPondState::TooOld, Some("2.22.2"))
    );
    assert!(old.message.contains("needs 2.24.0 or newer"));
    let broken = detect_lilypond(DetectOptions {
        version: Some(Box::new(|_| async { Err("killed".to_owned()) }.boxed())),
        ..found()
    })
    .await;
    assert_eq!(broken.state, LilyPondState::Broken);
    assert_eq!(
        detect_lilypond(DetectOptions {
            version: answers("hello\n"),
            ..found()
        })
        .await
        .state,
        LilyPondState::Broken
    );
    // The real `--version` of a script that prints nothing: not LilyPond.
    assert_eq!(detect_lilypond(found()).await.state, LilyPondState::Broken);
}

#[tokio::test]
async fn the_real_lilypond_when_installed() {
    let status = detect_lilypond(DetectOptions {
        configured_path: std::env::var("LILYPOND_PATH").ok(),
        path: common::search_path().get(),
        ..Default::default()
    })
    .await;
    if status.state == LilyPondState::Missing {
        eprintln!("skipped: lilypond is not installed");
        return;
    }
    assert_eq!(status.state, LilyPondState::Ready, "{}", status.message);
    assert!(status.version.as_deref().unwrap_or("").starts_with("2."));
}

#[test]
fn versions() {
    assert_eq!(
        parse_version("GNU LilyPond 2.24.4 (running Guile 2.2)").as_deref(),
        Some("2.24.4")
    );
    assert_eq!(parse_version("lilypond 2.25").as_deref(), Some("2.25"));
    assert_eq!(parse_version("Usage: foo"), None);
    assert_eq!(compare_versions("2.24.0", "2.24"), 0);
    assert!(compare_versions("2.23.99", "2.24.0") < 0);
    assert!(compare_versions("2.100.0", "2.24.0") > 0);
}

#[test]
fn an_app_bundle_is_looked_into() {
    assert_eq!(
        choice_path("/Applications/LilyPond.app"),
        "/Applications/LilyPond.app/Contents/Resources/bin"
    );
    assert_eq!(
        choice_path("/Applications/lilypond-2.24.4"),
        "/Applications/lilypond-2.24.4"
    );
}

#[test]
fn the_search_path_keeps_order_adds_the_binary_first_drops_repeats() {
    let joined = search_path(Some("/usr/bin:/bin:/usr/bin"), Some("/x/bin"));
    let dirs: Vec<&str> = joined.split(':').collect();
    assert_eq!(dirs[..3], ["/x/bin", "/usr/bin", "/bin"]);
    let unique: std::collections::HashSet<&&str> = dirs.iter().collect();
    assert_eq!(unique.len(), dirs.len());
    if cfg!(target_os = "macos") {
        assert!(dirs.contains(&"/opt/homebrew/bin"));
    }
}

#[test]
fn setup_links() {
    assert_eq!(SETUP_LINKS.len(), 4);
    assert_eq!(
        setup_link("download"),
        Some("https://lilypond.org/download.html")
    );
    assert_eq!(setup_link("elsewhere"), None);
}

#[tokio::test]
async fn settings_survive_a_round_trip_and_a_damaged_file_reads_as_none() {
    let s = Scratch::new("lily-studio-setup-");
    let file = s.at("user/settings.json");
    assert_eq!(read_settings(&file).await, Settings::default());
    write_settings(
        &file,
        &Settings {
            lilypond_path: Some("/opt/lily/bin".into()),
            agents: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(
        tokio::fs::read_to_string(&file).await.unwrap(),
        "{\n  \"lilypondPath\": \"/opt/lily/bin\"\n}\n"
    );
    assert_eq!(
        read_settings(&file).await,
        Settings {
            lilypond_path: Some("/opt/lily/bin".into()),
            agents: None
        }
    );
    tokio::fs::write(&file, "{ nope").await.unwrap();
    assert_eq!(read_settings(&file).await, Settings::default());
    tokio::fs::write(&file, "{ \"lilypondPath\": 3 }")
        .await
        .unwrap();
    assert_eq!(read_settings(&file).await, Settings::default());
}

#[tokio::test]
async fn the_agents_paths_and_models_are_kept_and_nonsense_is_dropped() {
    let s = Scratch::new("lily-studio-agents-");
    let file = s.at("settings.json");
    let claude = AgentSettings {
        path: Some("/c".into()),
        model: Some("opus".into()),
    };
    let written = Settings {
        lilypond_path: Some("/l".into()),
        agents: Some(AgentsSettings {
            claude: Some(claude.clone()),
            codex: Some(AgentSettings::default()),
        }),
    };
    write_settings(&file, &written).await.unwrap();
    assert_eq!(
        read_settings(&file).await,
        Settings {
            lilypond_path: Some("/l".into()),
            agents: Some(AgentsSettings {
                claude: Some(claude),
                codex: None
            })
        }
    );
    tokio::fs::write(&file, r#"{"agents":{"claude":{"path":3},"codex":"x"}}"#)
        .await
        .unwrap();
    assert_eq!(read_settings(&file).await, Settings::default());
    let json = serde_json::to_value(&written).unwrap();
    assert_eq!(
        json,
        serde_json::json!({ "lilypondPath": "/l", "agents": { "claude": { "path": "/c", "model": "opus" }, "codex": {} } })
    );
}
