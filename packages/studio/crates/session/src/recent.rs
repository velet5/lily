//! The folders and scores opened last (DECISIONS D49), for the welcome screen
//! and File › Open Recent: at most ten, newest first, each path once, kept in
//! userData/recent.json. Every open adds to it, whichever way it came: a
//! dialog, New Score, the sample or the list itself. An entry whose path is
//! gone stays, marked, since a disk that is not connected comes back; opening
//! it says where it was.
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Entries kept at most.
pub const KEPT: usize = 10;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RecentKind {
    Folder,
    File,
}

impl RecentKind {
    /// Whether `path` is still there, and still a folder or a file.
    pub async fn exists_at(self, path: &Path) -> bool {
        match tokio::fs::metadata(path).await {
            Ok(meta) => match self {
                RecentKind::Folder => meta.is_dir(),
                RecentKind::File => meta.is_file(),
            },
            Err(_) => false,
        }
    }
}

/// One entry as recent.json keeps it; `opened` in milliseconds since 1970.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecentEntry {
    pub path: String,
    pub kind: RecentKind,
    pub opened: u64,
}

/// An entry as the page gets it: whether its path is still there.
#[derive(Clone, Debug, Serialize)]
pub struct Listed {
    #[serde(flatten)]
    pub entry: RecentEntry,
    pub exists: bool,
}

type Listener = Box<dyn Fn(&[RecentEntry]) + Send + Sync>;

pub struct RecentList {
    file: PathBuf,
    entries: tokio::sync::Mutex<Vec<RecentEntry>>,
    /// Told of every change, after it is saved: the menu and the page (lib.rs).
    listener: OnceLock<Listener>,
}

impl RecentList {
    /// Reads the file; a missing or broken one is an empty list, and broken entries are left out.
    pub async fn load(file: PathBuf) -> RecentList {
        let mut entries = Vec::new();
        if let Ok(text) = tokio::fs::read_to_string(&file).await
            && let Ok(Value::Array(saved)) = serde_json::from_str::<Value>(&text)
        {
            // Oldest first, so the newest end up in front.
            for value in saved.into_iter().rev() {
                if let Ok(entry) = serde_json::from_value::<RecentEntry>(value)
                    && !entry.path.is_empty()
                {
                    push(&mut entries, entry);
                }
            }
        }
        RecentList {
            file,
            entries: tokio::sync::Mutex::new(entries),
            listener: OnceLock::new(),
        }
    }

    /// Sets the one listener; a second is ignored.
    pub fn on_change(&self, listener: impl Fn(&[RecentEntry]) + Send + Sync + 'static) {
        let _ = self.listener.set(Box::new(listener));
    }

    pub async fn entries(&self) -> Vec<RecentEntry> {
        self.entries.lock().await.clone()
    }

    /// The entries, each with whether its path is still there.
    pub async fn listed(&self) -> Vec<Listed> {
        let entries = self.entries().await;
        let mut listed = Vec::with_capacity(entries.len());
        for entry in entries {
            let exists = entry.kind.exists_at(Path::new(&entry.path)).await;
            listed.push(Listed { entry, exists });
        }
        listed
    }

    pub async fn find(&self, path: &str) -> Option<RecentEntry> {
        let entries = self.entries.lock().await;
        entries.iter().find(|entry| entry.path == path).cloned()
    }

    /// Puts `path` in front, opened now.
    pub async fn add(&self, path: &Path, kind: RecentKind) -> Result<(), String> {
        let entry = RecentEntry {
            path: path.to_string_lossy().into_owned(),
            kind,
            opened: now(),
        };
        self.change(|entries| push(entries, entry)).await
    }

    pub async fn remove(&self, path: &str) -> Result<(), String> {
        self.change(|entries| entries.retain(|entry| entry.path != path))
            .await
    }

    pub async fn clear(&self) -> Result<(), String> {
        self.change(Vec::clear).await
    }

    async fn change(&self, change: impl FnOnce(&mut Vec<RecentEntry>)) -> Result<(), String> {
        let mut entries = self.entries.lock().await;
        let before = entries.clone();
        change(&mut entries);
        if *entries == before {
            return Ok(());
        }
        // Written under the lock, so the file never goes back to an older list.
        let written = write(&self.file, &entries)
            .await
            .map_err(|error| format!("The recent list could not be saved: {error}"));
        if let Some(listener) = self.listener.get() {
            listener(&entries);
        }
        written
    }
}

/// Puts `entry` in front, drops an older entry of its path, and keeps `KEPT`.
pub fn push(entries: &mut Vec<RecentEntry>, entry: RecentEntry) {
    entries.retain(|kept| kept.path != entry.path);
    entries.insert(0, entry);
    entries.truncate(KEPT);
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_millis() as u64)
        .unwrap_or(0)
}

async fn write(file: &Path, entries: &[RecentEntry]) -> std::io::Result<()> {
    if let Some(parent) = file.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let text = serde_json::to_string_pretty(entries).map_err(std::io::Error::other)?;
    tokio::fs::write(file, format!("{text}\n")).await
}

/// `path` with the home directory as `~`, for messages and the menu.
pub fn tilde(path: &Path, home: Option<&Path>) -> String {
    if let Some(home) = home.filter(|home| !home.as_os_str().is_empty())
        && let Ok(rest) = path.strip_prefix(home)
    {
        return if rest.as_os_str().is_empty() {
            "~".into()
        } else {
            format!("~/{}", rest.display())
        };
    }
    path.display().to_string()
}

/// What opening a gone entry says.
pub fn missing_message(entry: &RecentEntry, home: Option<&Path>) -> String {
    let path = Path::new(&entry.path);
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| entry.path.clone());
    let place = path
        .parent()
        .map(|parent| tilde(parent, home))
        .unwrap_or_default();
    let what = match entry.kind {
        RecentKind::Folder => "folder",
        RecentKind::File => "score",
    };
    format!(
        "The {what} {name} is no longer in {place}. It was moved, renamed or deleted, or its disk is not connected."
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn entry(path: &str, kind: RecentKind, opened: u64) -> RecentEntry {
        RecentEntry {
            path: path.into(),
            kind,
            opened,
        }
    }

    #[test]
    fn newest_first_each_path_once_ten_at_most() {
        let mut entries = Vec::new();
        for i in 0..12 {
            push(
                &mut entries,
                entry(&format!("/s/{i}.ly"), RecentKind::File, i),
            );
        }
        push(&mut entries, entry("/s/5.ly", RecentKind::File, 99));
        let paths: Vec<&str> = entries.iter().map(|e| e.path.as_str()).collect();
        assert_eq!(
            paths,
            [
                "/s/5.ly", "/s/11.ly", "/s/10.ly", "/s/9.ly", "/s/8.ly", "/s/7.ly", "/s/6.ly",
                "/s/4.ly", "/s/3.ly", "/s/2.ly"
            ]
        );
        assert_eq!(entries[0].opened, 99);
    }

    #[test]
    fn tilde_for_the_home_directory() {
        let home = Path::new("/Users/me");
        assert_eq!(tilde(Path::new("/Users/me/Music"), Some(home)), "~/Music");
        assert_eq!(tilde(Path::new("/Users/me"), Some(home)), "~");
        assert_eq!(tilde(Path::new("/Users/meg/x"), Some(home)), "/Users/meg/x");
        assert_eq!(tilde(Path::new("/Volumes/T5"), None), "/Volumes/T5");
    }

    #[test]
    fn says_where_a_gone_entry_was() {
        let gone = entry("/Users/me/Music/song.ly", RecentKind::File, 1);
        assert_eq!(
            missing_message(&gone, Some(Path::new("/Users/me"))),
            "The score song.ly is no longer in ~/Music. It was moved, renamed or deleted, or its disk is not connected."
        );
    }

    #[tokio::test]
    async fn saves_loads_and_marks_what_is_gone() {
        let dir = std::env::temp_dir().join(format!("lily-recent-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let folder = dir.join("scores");
        std::fs::create_dir_all(&folder).unwrap();
        let score = folder.join("a.ly");
        std::fs::write(&score, "{ c }").unwrap();
        let file = dir.join("recent.json");

        let recent = RecentList::load(file.clone()).await;
        let changes = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counted = changes.clone();
        recent.on_change(move |_| {
            counted.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        });
        recent.add(&folder, RecentKind::Folder).await.unwrap();
        recent.add(&score, RecentKind::File).await.unwrap();
        recent
            .add(&dir.join("gone.ly"), RecentKind::File)
            .await
            .unwrap();
        recent.remove("/not/there").await.unwrap();
        assert_eq!(changes.load(std::sync::atomic::Ordering::SeqCst), 3);

        let again = RecentList::load(file.clone()).await;
        let listed: Vec<(String, RecentKind, bool)> = again
            .listed()
            .await
            .into_iter()
            .map(|l| (l.entry.path, l.entry.kind, l.exists))
            .collect();
        let path = |p: &Path| p.to_string_lossy().into_owned();
        assert_eq!(
            listed,
            [
                (path(&dir.join("gone.ly")), RecentKind::File, false),
                (path(&score), RecentKind::File, true),
                (path(&folder), RecentKind::Folder, true),
            ]
        );

        again.remove(&path(&score)).await.unwrap();
        assert_eq!(
            RecentList::load(file.clone()).await.entries().await.len(),
            2
        );
        again.clear().await.unwrap();
        assert!(RecentList::load(file).await.entries().await.is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn a_broken_file_loads_what_it_can() {
        let dir = std::env::temp_dir().join(format!("lily-recent-broken-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("recent.json");
        let saved = json!([
            { "path": "/a", "kind": "folder", "opened": 2 },
            { "path": "/b", "kind": "disk", "opened": 1 },
            { "path": "/a", "kind": "folder", "opened": 1 },
            "text",
            { "path": "/c.ly", "kind": "file", "opened": 0 },
        ]);
        std::fs::write(&file, saved.to_string()).unwrap();
        let entries = RecentList::load(file.clone()).await.entries().await;
        assert_eq!(
            entries,
            [
                entry("/a", RecentKind::Folder, 2),
                entry("/c.ly", RecentKind::File, 0)
            ]
        );
        std::fs::write(&file, "not json").unwrap();
        assert!(RecentList::load(file).await.entries().await.is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }
}
