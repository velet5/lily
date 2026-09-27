//! From studio/test/watcher.test.ts, against the real file system and its
//! change events.

mod common;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use common::{Scratch, sleep};
use lily_engrave::{FileChange, ScoreWatcher};
use tokio::sync::Notify;

#[derive(Debug, PartialEq)]
struct Report {
    changes: Vec<FileChange>,
    score: bool,
}

struct Case {
    scratch: Scratch,
    watcher: ScoreWatcher,
    reports: Arc<Mutex<Vec<Report>>>,
    wake: Arc<Notify>,
}

impl Drop for Case {
    fn drop(&mut self) {
        self.watcher.dispose();
    }
}

impl Case {
    async fn new(files: &[(&str, &str)]) -> Case {
        let scratch = Scratch::new("lily-studio-watch-");
        for (name, text) in files {
            scratch.write(name, text).await;
        }
        let reports: Arc<Mutex<Vec<Report>>> = Arc::default();
        let wake = Arc::new(Notify::new());
        let (sink, bell) = (reports.clone(), wake.clone());
        let watcher = ScoreWatcher::with_delay(
            move |changes, score| {
                sink.lock().unwrap().push(Report { changes, score });
                bell.notify_one();
            },
            Duration::from_millis(50),
        );
        Case {
            scratch,
            watcher,
            reports,
            wake,
        }
    }

    fn at(&self, name: &str) -> PathBuf {
        self.scratch.at(name)
    }

    /// Lets events from before the watch pass, then forgets them.
    async fn settle(&self) {
        sleep(150).await;
        self.reports.lock().unwrap().clear();
    }

    /// The next report, or `None` when none comes within `ms`.
    async fn next(&self, ms: u64) -> Option<Report> {
        if self.reports.lock().unwrap().is_empty() {
            let _ = tokio::time::timeout(Duration::from_millis(ms), self.wake.notified()).await;
        }
        let mut reports = self.reports.lock().unwrap();
        if reports.is_empty() {
            None
        } else {
            Some(reports.remove(0))
        }
    }

    async fn write(&self, name: &str, text: &str) {
        tokio::fs::write(self.at(name), text).await.unwrap();
    }
}

fn change(file: PathBuf, exists: bool) -> Vec<FileChange> {
    vec![FileChange { file, exists }]
}

const SCORE: &str = "\\version \"2.24.0\"\n\\include \"parts/melody.ily\"\n{ \\melody }\n";

#[tokio::test]
async fn reports_a_change_to_an_open_file_under_the_path_the_editor_used() {
    let t = Case::new(&[("solo.ly", "{ c }\n")]).await;
    t.watcher.open(&t.at("solo.ly"), "{ c }\n").await;
    t.settle().await;
    t.write("solo.ly", "{ d }\n").await;
    assert_eq!(
        t.next(3000).await,
        Some(Report {
            changes: change(t.at("solo.ly"), true),
            score: false
        })
    );
}

#[tokio::test]
async fn does_not_report_the_studios_own_save_or_a_write_of_the_same_text() {
    let t = Case::new(&[("solo.ly", "{ c }\n")]).await;
    t.watcher.open(&t.at("solo.ly"), "{ c }\n").await;
    t.settle().await;
    t.watcher.writing(&t.at("solo.ly"), "{ e }\n").await;
    t.write("solo.ly", "{ e }\n").await;
    t.write("solo.ly", "{ e }\n").await;
    assert_eq!(t.next(500).await, None);
}

#[tokio::test]
async fn reports_a_burst_of_writes_once_when_it_settles() {
    let t = Case::new(&[("solo.ly", "{ c }\n")]).await;
    t.watcher.open(&t.at("solo.ly"), "{ c }\n").await;
    t.settle().await;
    for note in ["d", "e", "f"] {
        t.write("solo.ly", &format!("{{ {note} }}\n")).await;
    }
    assert_eq!(
        t.next(3000).await.map(|r| r.changes),
        Some(change(t.at("solo.ly"), true))
    );
    assert_eq!(t.next(300).await, None);
}

#[tokio::test]
async fn an_include_of_the_watched_score_changing_asks_for_a_compile() {
    let t = Case::new(&[
        ("song.ly", SCORE),
        ("parts/melody.ily", "melody = { c1 }\n"),
    ])
    .await;
    t.watcher.watch_score(&t.at("song.ly")).await;
    assert_eq!(t.watcher.score(), Some(t.at("song.ly")));
    t.settle().await;
    t.write("parts/melody.ily", "melody = { d1 }\n").await;
    assert_eq!(
        t.next(3000).await,
        Some(Report {
            changes: change(t.at("parts/melody.ily"), true),
            score: true
        })
    );
}

#[tokio::test]
async fn an_editor_that_saves_by_renaming_over_the_file_is_still_seen_twice() {
    let t = Case::new(&[
        ("song.ly", SCORE),
        ("parts/melody.ily", "melody = { c1 }\n"),
    ])
    .await;
    t.watcher.watch_score(&t.at("song.ly")).await;
    t.settle().await;
    for note in ["d", "e"] {
        t.write("parts/.melody.tmp", &format!("melody = {{ {note}1 }}\n"))
            .await;
        tokio::fs::rename(t.at("parts/.melody.tmp"), t.at("parts/melody.ily"))
            .await
            .unwrap();
        assert_eq!(
            t.next(3000).await.map(|r| r.score),
            Some(true),
            "after saving {note}"
        );
    }
}

#[tokio::test]
async fn a_missing_include_that_appears_asks_for_a_compile_a_deleted_one_too() {
    let t = Case::new(&[("song.ly", SCORE), ("parts/other.ily", "")]).await;
    t.watcher.watch_score(&t.at("song.ly")).await;
    t.settle().await;
    t.write("parts/melody.ily", "melody = { c1 }\n").await;
    assert_eq!(
        t.next(3000).await,
        Some(Report {
            changes: change(t.at("parts/melody.ily"), true),
            score: true
        })
    );
    tokio::fs::remove_file(t.at("parts/melody.ily"))
        .await
        .unwrap();
    assert_eq!(
        t.next(3000).await,
        Some(Report {
            changes: change(t.at("parts/melody.ily"), false),
            score: true
        })
    );
}

#[tokio::test]
async fn another_score_replaces_the_first_files_open_in_the_editor_stay_watched() {
    let t = Case::new(&[
        ("song.ly", SCORE),
        ("parts/melody.ily", "melody = { c1 }\n"),
        ("solo.ly", "{ c }\n"),
    ])
    .await;
    t.watcher.open(&t.at("song.ly"), SCORE).await;
    t.watcher.watch_score(&t.at("song.ly")).await;
    t.watcher.watch_score(&t.at("solo.ly")).await;
    t.settle().await;
    t.write("parts/melody.ily", "melody = { d1 }\n").await;
    assert_eq!(t.next(500).await, None);
    t.write("song.ly", &format!("{SCORE}% edited\n")).await;
    assert_eq!(
        t.next(3000).await,
        Some(Report {
            changes: change(t.at("song.ly"), true),
            score: false
        })
    );
    t.write("solo.ly", "{ d }\n").await;
    assert_eq!(
        t.next(3000).await,
        Some(Report {
            changes: change(t.at("solo.ly"), true),
            score: true
        })
    );
}

#[tokio::test]
async fn says_nothing_after_dispose() {
    let t = Case::new(&[("solo.ly", "{ c }\n")]).await;
    t.watcher.open(&t.at("solo.ly"), "{ c }\n").await;
    t.settle().await;
    t.watcher.dispose();
    t.write("solo.ly", "{ d }\n").await;
    assert_eq!(t.next(300).await, None);
}

#[test]
fn a_change_serializes_as_the_typescript_shape() {
    let json = serde_json::to_value(FileChange {
        file: "/s/a.ly".into(),
        exists: false,
    })
    .unwrap();
    assert_eq!(
        json,
        serde_json::json!({ "file": "/s/a.ly", "exists": false })
    );
}
