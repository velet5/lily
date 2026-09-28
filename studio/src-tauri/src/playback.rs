//! Each score's playback setup (DECISIONS D45): the instrument and mute of its
//! parts, and the bar playback starts from, kept in userData/playback.json by
//! the score's path and read again when the score is played next. The file is
//! a list of `{ rootFile, setup }`, changed longest ago first. Only the
//! renderer's shape is kept; anything else it sends is dropped.
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

/// Setups kept at most; the ones changed longest ago go first.
const KEPT_SETUPS: usize = 200;
/// Parts per setup; lilypond writes a track per staff, and no score has more.
const MAX_PARTS: usize = 128;

pub struct PlaybackSetups {
    file: PathBuf,
    /// Root file and setup, changed longest ago first.
    setups: tokio::sync::Mutex<Vec<(String, Value)>>,
}

impl PlaybackSetups {
    pub async fn load(file: PathBuf) -> PlaybackSetups {
        let setups = match tokio::fs::read_to_string(&file).await {
            Ok(text) => match serde_json::from_str::<Value>(&text) {
                Ok(Value::Array(saved)) => saved
                    .iter()
                    .filter_map(|entry| {
                        let root = entry.get("rootFile")?.as_str()?;
                        Some((root.to_string(), clean(entry.get("setup")?)?))
                    })
                    .collect(),
                _ => Vec::new(),
            },
            Err(_) => Vec::new(),
        };
        PlaybackSetups {
            file,
            setups: tokio::sync::Mutex::new(setups),
        }
    }

    pub async fn get(&self, root_file: &str) -> Option<Value> {
        let setups = self.setups.lock().await;
        let found = setups.iter().find(|(root, _)| root == root_file);
        found.map(|(_, setup)| setup.clone())
    }

    /// Keeps `setup` for `root_file`, or forgets it when it is empty or null, and writes the file.
    pub async fn set(&self, root_file: &str, setup: &Value) -> Result<(), String> {
        let mut setups = self.setups.lock().await;
        setups.retain(|(root, _)| root != root_file);
        if let Some(setup) = clean(setup) {
            setups.push((root_file.to_string(), setup));
        }
        let excess = setups.len().saturating_sub(KEPT_SETUPS);
        setups.drain(..excess);
        // Written under the lock, so the file never goes back to an older setup.
        write(&self.file, &setups)
            .await
            .map_err(|error| format!("The playback setup could not be saved: {error}"))
    }
}

async fn write(file: &Path, setups: &[(String, Value)]) -> std::io::Result<()> {
    if let Some(parent) = file.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let entries: Vec<Value> = setups
        .iter()
        .map(|(root, setup)| serde_json::json!({ "rootFile": root, "setup": setup }))
        .collect();
    let text = serde_json::to_string_pretty(&entries).map_err(std::io::Error::other)?;
    tokio::fs::write(file, format!("{text}\n")).await
}

/// `{ parts: { "<track>": { program?, muted? } }, startBar? }` from whatever
/// came; None when nothing of it is left.
pub fn clean(setup: &Value) -> Option<Value> {
    let setup = setup.as_object()?;
    let mut parts = Map::new();
    if let Some(saved) = setup.get("parts").and_then(Value::as_object) {
        for (track, part) in saved.iter().take(MAX_PARTS) {
            if track.parse::<u16>().is_err() {
                continue;
            }
            let Some(part) = part.as_object() else {
                continue;
            };
            let mut kept = Map::new();
            if let Some(program) = part.get("program").and_then(Value::as_u64)
                && program < 128
            {
                kept.insert("program".into(), program.into());
            }
            if part.get("muted") == Some(&Value::Bool(true)) {
                kept.insert("muted".into(), true.into());
            }
            if !kept.is_empty() {
                parts.insert(track.clone(), kept.into());
            }
        }
    }
    let mut kept = Map::new();
    if !parts.is_empty() {
        kept.insert("parts".into(), parts.into());
    }
    if let Some(bar) = setup.get("startBar").and_then(Value::as_u64)
        && bar > 0
        && bar < 100_000
    {
        kept.insert("startBar".into(), bar.into());
    }
    (!kept.is_empty()).then_some(kept.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn keeps_only_the_setup() {
        let setup = json!({
            "parts": {
                "1": { "program": 40, "muted": true, "extra": 1 },
                "2": { "program": 300, "muted": false },
                "x": { "muted": true },
                "3": "loud",
            },
            "startBar": 5,
            "other": true,
        });
        assert_eq!(
            clean(&setup),
            Some(json!({ "parts": { "1": { "program": 40, "muted": true } }, "startBar": 5 }))
        );
    }

    #[test]
    fn an_empty_setup_is_none() {
        assert_eq!(clean(&json!({ "parts": {}, "startBar": 0 })), None);
        assert_eq!(clean(&Value::Null), None);
    }

    #[tokio::test]
    async fn saves_and_loads() {
        let dir = std::env::temp_dir().join(format!("lily-playback-{}", std::process::id()));
        let file = dir.join("playback.json");
        let setups = PlaybackSetups::load(file.clone()).await;
        setups
            .set("/a.ly", &json!({ "parts": { "2": { "muted": true } } }))
            .await
            .unwrap();
        setups
            .set("/b.ly", &json!({ "startBar": 3 }))
            .await
            .unwrap();
        setups.set("/b.ly", &Value::Null).await.unwrap();
        let again = PlaybackSetups::load(file).await;
        assert_eq!(
            again.get("/a.ly").await,
            Some(json!({ "parts": { "2": { "muted": true } } }))
        );
        assert_eq!(again.get("/b.ly").await, None);
        let _ = std::fs::remove_dir_all(dir);
    }
}
