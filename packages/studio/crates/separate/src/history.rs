//! The songs separated before (DECISIONS D114), so the Stems view can open
//! them again instead of separating them on every launch: at most twenty,
//! last opened first, each folder once, kept in userData/separations.json.
//! A separation goes on it when it is done, and a folder of stems chosen
//! with the panel when it is opened; opening one puts it in front. An entry
//! whose folder is gone stays, marked, since a disk that is not connected
//! comes back.
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Entries kept at most.
pub const KEPT: usize = 20;

/// The stems in the order the view lists them; any other stem comes after, by name.
const ORDER: &[&str] = &[
    "instrumental",
    "vocals",
    "drums",
    "bass",
    "guitar",
    "piano",
    "other",
];

/// What karaoke-mlx writes, and what a mix is exported as.
const AUDIO: &[&str] = &["wav", "flac", "mp3"];

/// A stem file, as karaoke-mlx's `done` event names it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Output {
    pub stem: String,
    pub path: String,
}

/// One separation as separations.json keeps it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Separation {
    /// The folder the stems are in, `<song> (karaoke)` or `<song> (stems)`.
    pub folder: String,
    pub outputs: Vec<Output>,
    /// How long it took; absent for a folder chosen with the panel.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seconds: Option<f64>,
    /// When it was separated or opened last, in milliseconds since 1970.
    pub opened: u64,
}

impl Separation {
    /// The separation a `done` event reports, opened now.
    pub fn from_done(event: &Value) -> Option<Separation> {
        if event["event"] != "done" {
            return None;
        }
        let outputs: Vec<Output> = serde_json::from_value(event["outputs"].clone()).ok()?;
        Some(Separation {
            folder: event["folder"].as_str()?.to_string(),
            outputs,
            seconds: event["seconds"].as_f64(),
            opened: now(),
        })
    }
}

/// An entry as the page gets it: whether its folder is still there.
#[derive(Clone, Debug, Serialize)]
pub struct Listed {
    #[serde(flatten)]
    pub separation: Separation,
    pub exists: bool,
}

pub struct History {
    file: std::path::PathBuf,
    entries: tokio::sync::Mutex<Vec<Separation>>,
}

impl History {
    /// Reads the file; a missing or broken one is an empty list, and broken entries are left out.
    pub async fn load(file: std::path::PathBuf) -> History {
        let mut entries = Vec::new();
        if let Ok(text) = tokio::fs::read_to_string(&file).await
            && let Ok(Value::Array(saved)) = serde_json::from_str::<Value>(&text)
        {
            // Oldest first, so the newest end up in front.
            for value in saved.into_iter().rev() {
                if let Ok(entry) = serde_json::from_value::<Separation>(value)
                    && !entry.folder.is_empty()
                {
                    push(&mut entries, entry);
                }
            }
        }
        History {
            file,
            entries: tokio::sync::Mutex::new(entries),
        }
    }

    /// The entries, each with whether its folder is still there.
    pub async fn listed(&self) -> Vec<Listed> {
        let entries = self.entries.lock().await.clone();
        let mut listed = Vec::with_capacity(entries.len());
        for separation in entries {
            let exists = tokio::fs::metadata(&separation.folder)
                .await
                .is_ok_and(|meta| meta.is_dir());
            listed.push(Listed { separation, exists });
        }
        listed
    }

    pub async fn find(&self, folder: &str) -> Option<Separation> {
        let entries = self.entries.lock().await;
        entries.iter().find(|entry| entry.folder == folder).cloned()
    }

    /// Puts `separation` in front, opened now.
    pub async fn add(&self, separation: Separation) -> Result<(), String> {
        let separation = Separation {
            opened: now(),
            ..separation
        };
        self.change(|entries| push(entries, separation)).await
    }

    pub async fn remove(&self, folder: &str) -> Result<(), String> {
        self.change(|entries| entries.retain(|entry| entry.folder != folder))
            .await
    }

    async fn change(&self, change: impl FnOnce(&mut Vec<Separation>)) -> Result<(), String> {
        let mut entries = self.entries.lock().await;
        let before = entries.clone();
        change(&mut entries);
        if *entries == before {
            return Ok(());
        }
        // Written under the lock, so the file never goes back to an older list.
        write(&self.file, &entries)
            .await
            .map_err(|error| format!("The separated songs could not be saved: {error}"))
    }
}

/// Puts `entry` in front, drops an older entry of its folder, and keeps `KEPT`.
pub fn push(entries: &mut Vec<Separation>, entry: Separation) {
    entries.retain(|kept| kept.folder != entry.folder);
    entries.insert(0, entry);
    entries.truncate(KEPT);
}

/// Those of `outputs` still on disk.
pub fn present(outputs: &[Output]) -> Vec<Output> {
    outputs
        .iter()
        .filter(|output| Path::new(&output.path).is_file())
        .cloned()
        .collect()
}

/// The stems in `folder`, as karaoke-mlx names them: `<song> - <stem>.<ext>`,
/// in the view's order. A mix exported beside them (`<song> - mix.wav`) is not a stem.
pub fn scan(folder: &Path) -> Result<Vec<Output>, String> {
    let read =
        std::fs::read_dir(folder).map_err(|error| format!("{}: {error}", folder.display()))?;
    let mut outputs: Vec<Output> = read
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        .filter_map(|entry| {
            let path = entry.path();
            let ext = path.extension()?.to_str()?.to_ascii_lowercase();
            let name = path.file_stem()?.to_str()?;
            let (_, stem) = name.rsplit_once(" - ")?;
            let plain = !stem.is_empty()
                && stem
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_');
            (AUDIO.contains(&ext.as_str()) && plain && stem != "mix").then(|| Output {
                stem: stem.to_string(),
                path: path.to_string_lossy().into_owned(),
            })
        })
        .collect();
    outputs.sort_by(|a, b| {
        let rank = |stem: &str| {
            ORDER
                .iter()
                .position(|known| *known == stem)
                .unwrap_or(ORDER.len())
        };
        (rank(&a.stem), &a.stem, &a.path).cmp(&(rank(&b.stem), &b.stem, &b.path))
    });
    if outputs.is_empty() {
        return Err(format!(
            "{} holds no stems: files named “<song> - vocals.wav” and so on, as separating writes them.",
            folder.display()
        ));
    }
    Ok(outputs)
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_millis() as u64)
        .unwrap_or(0)
}

async fn write(file: &Path, entries: &[Separation]) -> std::io::Result<()> {
    if let Some(parent) = file.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let text = serde_json::to_string_pretty(entries).map_err(std::io::Error::other)?;
    tokio::fs::write(file, format!("{text}\n")).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn entry(folder: &str, opened: u64) -> Separation {
        Separation {
            folder: folder.into(),
            outputs: vec![],
            seconds: None,
            opened,
        }
    }

    #[test]
    fn a_done_event_is_a_separation() {
        let done = json!({
            "event": "done",
            "folder": "/s/song (karaoke)",
            "outputs": [{ "stem": "vocals", "path": "/s/song (karaoke)/song - vocals.wav" }],
            "seconds": 81.5,
        });
        let separation = Separation::from_done(&done).unwrap();
        assert_eq!(separation.folder, "/s/song (karaoke)");
        assert_eq!(separation.outputs[0].stem, "vocals");
        assert_eq!(separation.seconds, Some(81.5));
        assert!(Separation::from_done(&json!({ "event": "progress" })).is_none());
        assert!(Separation::from_done(&json!({ "event": "done", "outputs": [] })).is_none());
    }

    #[test]
    fn last_opened_first_each_folder_once() {
        let mut entries = Vec::new();
        for i in 0..(KEPT as u64 + 2) {
            push(&mut entries, entry(&format!("/s/{i} (stems)"), i));
        }
        push(&mut entries, entry("/s/5 (stems)", 99));
        assert_eq!(entries.len(), KEPT);
        assert_eq!(entries[0].folder, "/s/5 (stems)");
        assert_eq!(entries[1].folder, format!("/s/{} (stems)", KEPT + 1));
        assert_eq!(
            entries
                .iter()
                .filter(|e| e.folder == "/s/5 (stems)")
                .count(),
            1
        );
    }

    #[test]
    fn a_folders_stems_in_the_views_order() {
        let scratch = tempfile::tempdir().unwrap();
        let folder = scratch.path().join("Song - Live (stems)");
        std::fs::create_dir_all(folder.join("nested - bass.wav")).unwrap();
        for name in [
            "Song - Live - vocals.wav",
            "Song - Live - bass.wav",
            "Song - Live - drums.wav",
            "Song - Live - mix.wav",
            "Song - Live - harp.flac",
            "notes - vocals.txt",
            "cover.png",
        ] {
            std::fs::write(folder.join(name), b"").unwrap();
        }
        let stems: Vec<String> = scan(&folder).unwrap().into_iter().map(|o| o.stem).collect();
        assert_eq!(stems, ["vocals", "drums", "bass", "harp"]);
        assert!(scan(scratch.path()).is_err(), "a folder without stems");
        assert!(scan(&scratch.path().join("missing")).is_err());
    }

    #[tokio::test]
    async fn saves_loads_and_marks_what_is_gone() {
        let scratch = tempfile::tempdir().unwrap();
        let folder = scratch.path().join("song (karaoke)");
        std::fs::create_dir_all(&folder).unwrap();
        let stem = folder.join("song - vocals.wav");
        std::fs::write(&stem, b"RIFF").unwrap();
        let file = scratch.path().join("data").join("separations.json");
        let path = |p: &Path| p.to_string_lossy().into_owned();

        let history = History::load(file.clone()).await;
        let mut kept = entry(&path(&folder), 0);
        kept.outputs = vec![
            Output {
                stem: "vocals".into(),
                path: path(&stem),
            },
            Output {
                stem: "instrumental".into(),
                path: path(&folder.join("gone.wav")),
            },
        ];
        history.add(kept.clone()).await.unwrap();
        history.add(entry("/gone (stems)", 0)).await.unwrap();

        let again = History::load(file.clone()).await;
        let listed: Vec<(String, bool)> = again
            .listed()
            .await
            .into_iter()
            .map(|l| (l.separation.folder, l.exists))
            .collect();
        assert_eq!(
            listed,
            [("/gone (stems)".into(), false), (path(&folder), true)]
        );
        let found = again.find(&path(&folder)).await.unwrap();
        assert!(found.opened > 0);
        assert_eq!(present(&found.outputs), kept.outputs[..1]);

        again.remove("/gone (stems)").await.unwrap();
        assert_eq!(History::load(file.clone()).await.listed().await.len(), 1);
        std::fs::write(&file, "not json").unwrap();
        assert!(History::load(file).await.listed().await.is_empty());
    }
}
