//! From studio/test/liveCompile.test.ts: LiveCompile with a stand-in for
//! StudioCompiler that records which scores were compiled, with the buffers
//! of the moment.

mod common;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use common::sleep;
use futures::FutureExt;
use futures::future::BoxFuture;
use lily_engrave::{
    CompileOutcome, LiveCompile, LiveOptions, LiveTarget, LiveTexts, SourceBuffers,
};

struct StandIn {
    /// file → its root; a file not in the map is its own root.
    roots: HashMap<PathBuf, Option<PathBuf>>,
    texts: LiveTexts,
    current: Mutex<Option<PathBuf>>,
    compiled: Mutex<Vec<(PathBuf, SourceBuffers)>>,
}

impl LiveTarget for StandIn {
    fn current(&self) -> Option<PathBuf> {
        self.current.lock().unwrap().clone()
    }

    fn root_for(&self, file: PathBuf) -> BoxFuture<'static, Option<PathBuf>> {
        let root = self.roots.get(&file).cloned().unwrap_or(Some(file));
        async move { root }.boxed()
    }

    fn compile(&self, root: PathBuf) -> BoxFuture<'static, Option<CompileOutcome>> {
        *self.current.lock().unwrap() = Some(root.clone());
        self.compiled
            .lock()
            .unwrap()
            .push((root, self.texts.buffers()));
        async { None }.boxed()
    }
}

fn stand_in(roots: &[(&str, Option<&str>)]) -> (LiveCompile, Arc<StandIn>) {
    let texts = LiveTexts::new(true);
    let target = Arc::new(StandIn {
        roots: roots
            .iter()
            .map(|(f, r)| (PathBuf::from(f), r.map(PathBuf::from)))
            .collect(),
        texts: texts.clone(),
        current: Mutex::default(),
        compiled: Mutex::default(),
    });
    let options = LiveOptions {
        delay: Duration::from_millis(30),
        max_wait: Duration::from_millis(90),
    };
    (LiveCompile::new(target.clone(), texts, options), target)
}

fn roots(target: &StandIn) -> Vec<PathBuf> {
    target
        .compiled
        .lock()
        .unwrap()
        .iter()
        .map(|(root, _)| root.clone())
        .collect()
}

fn roots_and_sizes(target: &StandIn) -> Vec<(PathBuf, usize)> {
    target
        .compiled
        .lock()
        .unwrap()
        .iter()
        .map(|(root, buffers)| (root.clone(), buffers.len()))
        .collect()
}

const SCORE: &str = "/s/score.ly";

#[tokio::test]
async fn a_burst_of_edits_compiles_its_score_once_with_the_unsaved_texts() {
    let (live, target) = stand_in(&[]);
    live.edited(SCORE, Some("{ c }".into()));
    live.edited(SCORE, Some("{ c d }".into()));
    live.edited(SCORE, Some("{ c d e }".into()));
    sleep(10).await;
    assert!(roots(&target).is_empty());
    sleep(60).await;
    assert_eq!(roots(&target), [PathBuf::from(SCORE)]);
    let buffers = target.compiled.lock().unwrap()[0].1.clone();
    assert_eq!(
        buffers,
        [(PathBuf::from(SCORE), "{ c d e }".to_owned())]
            .into_iter()
            .collect()
    );
    live.dispose();
}

#[tokio::test]
async fn typing_without_a_pause_still_compiles_within_the_longest_wait() {
    let (live, target) = stand_in(&[]);
    for i in 0..12 {
        live.edited(SCORE, Some(format!("{{ c{i} }}")));
        sleep(15).await;
    }
    // 180 ms of typing, never 30 ms quiet: the 90 ms deadline compiled at least once.
    assert!(
        !roots(&target).is_empty(),
        "compiled {} times",
        roots(&target).len()
    );
    live.dispose();
}

#[tokio::test]
async fn an_edited_include_compiles_the_score_it_belongs_to_one_no_score_reaches_nothing() {
    let (live, target) = stand_in(&[("/s/parts/a.ily", Some(SCORE)), ("/s/parts/b.ily", None)]);
    live.edited("/s/parts/a.ily", Some("a = { c }".into()));
    live.edited(SCORE, Some("\\include \"parts/a.ily\"".into()));
    live.edited("/s/parts/b.ily", Some("b = { d }".into()));
    sleep(60).await;
    assert_eq!(roots_and_sizes(&target), [(PathBuf::from(SCORE), 3)]);
    live.dispose();
}

#[tokio::test]
async fn a_save_or_reload_drops_the_files_text_and_what_was_waiting_for_it() {
    let (live, target) = stand_in(&[]);
    live.edited(SCORE, Some("{ c d }".into()));
    live.edited(SCORE, None);
    sleep(60).await;
    assert!(roots(&target).is_empty());
    assert!(live.buffers().is_empty());
}

#[tokio::test]
async fn off_edits_wait_compiles_read_the_disk_on_again_they_compile() {
    let (live, target) = stand_in(&[]);
    live.set_enabled(false);
    assert!(!live.enabled());
    live.edited(SCORE, Some("{ c d }".into()));
    sleep(60).await;
    assert!(roots(&target).is_empty());
    assert!(live.buffers().is_empty());

    live.set_enabled(true);
    sleep(10).await;
    assert_eq!(roots_and_sizes(&target), [(PathBuf::from(SCORE), 1)]);

    // Off again: the score shown compiles from disk, and what was waiting is dropped.
    live.edited(SCORE, Some("{ c d e }".into()));
    live.set_enabled(false);
    sleep(60).await;
    assert_eq!(
        roots_and_sizes(&target),
        [(PathBuf::from(SCORE), 1), (PathBuf::from(SCORE), 0)]
    );
    live.dispose();
}

#[tokio::test]
async fn the_shared_texts_reach_a_studio_compiler_made_before_live_compile() {
    // The wiring the app uses: texts first, then the compiler that reads them,
    // then LiveCompile, which writes them.
    let texts = LiveTexts::new(true);
    let reader = texts.reader();
    let target = Arc::new(StandIn {
        roots: HashMap::new(),
        texts: texts.clone(),
        current: Mutex::default(),
        compiled: Mutex::default(),
    });
    let live = LiveCompile::new(target, texts, LiveOptions::default());
    live.edited(SCORE, Some("{ c }".into()));
    assert_eq!(
        reader().get(&PathBuf::from(SCORE)).map(String::as_str),
        Some("{ c }")
    );
    live.set_enabled(false);
    assert!(reader().is_empty());
    live.dispose();
}
