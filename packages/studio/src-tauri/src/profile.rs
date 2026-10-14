//! Where Lily Studio keeps the user's data (DECISIONS D112). Settings, the
//! recent list, chats and playback live in *Application Support › Lily
//! Studio*, the Electron studio's folder, named by the product and not by the
//! bundle identifier. Taking in stem separation changed neither, so nothing is
//! moved: the tests below fail if the name, the identifier or the folder
//! changes, and check that starting the studio leaves a profile as it was.
use std::path::{Path, PathBuf};

/// The folder in Application Support, the same since the Electron studio.
pub const DATA_FOLDER: &str = "Lily Studio";

/// `data_dir` is the system's (`~/Library/Application Support` on a Mac).
pub fn data_folder(data_dir: &Path) -> PathBuf {
    data_dir.join(DATA_FOLDER)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    /// WebKit's local storage and caches, and the single-instance socket
    /// that keeps two studios from writing one profile (#1200), follow it.
    const IDENTIFIER: &str = "io.github.velet5.lily-studio";
    const NAME: &str = "Lily Studio";

    fn json(text: &str) -> Value {
        serde_json::from_str(text).unwrap()
    }

    #[test]
    fn the_data_folder_is_the_electron_studios() {
        let support = Path::new("/Users/ada/Library/Application Support");
        assert_eq!(
            data_folder(support),
            Path::new("/Users/ada/Library/Application Support/Lily Studio")
        );
    }

    #[test]
    fn the_name_identifier_and_icon_are_kept() {
        let config = json(include_str!("../tauri.conf.json"));
        assert_eq!(config["identifier"], IDENTIFIER);
        assert_eq!(config["productName"], NAME);
        assert_eq!(config["mainBinaryName"], NAME);
        let icons = config["bundle"]["icon"].as_array().unwrap();
        assert!(icons.iter().any(|icon| icon == "icons/icon.icns"));
        let here = Path::new(env!("CARGO_MANIFEST_DIR"));
        for icon in icons {
            assert!(here.join(icon.as_str().unwrap()).is_file(), "{icon}");
        }

        let package = json(include_str!("../../package.json"));
        assert_eq!(package["productName"], NAME);
    }

    #[test]
    fn the_local_build_changes_only_its_signing() {
        let local = json(include_str!("../tauri.local.json"));
        let top: Vec<_> = local.as_object().unwrap().keys().collect();
        assert_eq!(top, ["bundle"]);
        let bundle: Vec<_> = local["bundle"].as_object().unwrap().keys().collect();
        assert_eq!(bundle, ["macOS"]);
        let mut mac: Vec<_> = local["bundle"]["macOS"]
            .as_object()
            .unwrap()
            .keys()
            .collect();
        mac.sort();
        assert_eq!(mac, ["hardenedRuntime", "signingIdentity"]);
    }

    #[tokio::test]
    async fn starting_leaves_a_profile_as_it_was() {
        let scratch = tempfile::tempdir().unwrap();
        let data = data_folder(scratch.path());
        std::fs::create_dir_all(data.join("Local Storage")).unwrap();
        // What an earlier studio left: its own files, the Electron studio's
        // Chromium folders, and something the studio does not know.
        let files = [
            (
                "settings.json",
                r#"{"lilypondPath":"/opt/lilypond/bin/lilypond"}"#,
            ),
            (
                "recent.json",
                r#"[{"path":"/Users/ada/Scores/ode.ly","kind":"file"}]"#,
            ),
            ("playback.json", "{}"),
            ("chats.json", "[]"),
            ("Local Storage/leveldb.log", "kept"),
            ("notes.txt", "mine"),
        ];
        for (name, text) in files {
            std::fs::write(data.join(name), text).unwrap();
        }

        let documents = scratch.path().join("Documents");
        let studio =
            lily_session::Studio::new(lily_session::StudioOptions::new(lily_session::Paths {
                data: data.clone(),
                documents: documents.clone(),
                runtime: scratch.path().join("runtime"),
            }))
            .await;
        studio.dispose().await;

        for (name, text) in files {
            assert_eq!(
                std::fs::read_to_string(data.join(name)).unwrap(),
                text,
                "{name}"
            );
        }
        let mut left: Vec<_> = std::fs::read_dir(&data)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        left.sort();
        assert_eq!(
            left,
            [
                "Local Storage",
                "chats.json",
                "notes.txt",
                "playback.json",
                "recent.json",
                "settings.json"
            ]
        );
        assert!(!documents.exists(), "nothing is copied to Documents");
    }
}
