//! From studio/test/files.test.ts (the parts outside the renderer) and the
//! Access part of preview.test.ts.

mod common;

use std::path::PathBuf;

use common::Scratch;
use lily_engrave::Access;
use lily_engrave::files::{
    create_from_template, is_inside, list_folder, read_score, unused_name, write_score,
};
use lily_engrave::templates::{SAMPLE, TEMPLATES};

#[tokio::test]
async fn lists_lilypond_files_a_directorys_files_before_its_subdirectories() {
    let s = Scratch::new("lily-studio-test-");
    for name in [
        "list/Score 10.ly",
        "list/score 2.ly",
        "list/b/part.ily",
        "list/a/deep/x/y/z/too-deep.ly",
        "list/a/deep/x/y/fits.ly",
        "list/a/defs.lyi",
        "list/readme.txt",
        "list/.hidden/secret.ly",
        "list/.dot.ly",
        "list/node_modules/pkg/index.ly",
    ] {
        s.write(name, "").await;
    }
    let folder = s.at("list");
    let listing = list_folder(&folder).await;
    assert_eq!(listing.folder, folder);
    assert_eq!(listing.name, "list");
    assert!(!listing.truncated);
    let relative: Vec<&str> = listing.files.iter().map(|f| f.relative.as_str()).collect();
    assert_eq!(
        relative,
        [
            "score 2.ly",
            "Score 10.ly",
            "a/defs.lyi",
            "a/deep/x/y/fits.ly",
            "b/part.ily"
        ]
    );
    assert_eq!(listing.files[0].path, folder.join("score 2.ly"));
    let json = serde_json::to_value(&listing).unwrap();
    assert_eq!(
        json["files"][0],
        serde_json::json!({ "path": folder.join("score 2.ly"), "relative": "score 2.ly" })
    );
    assert_eq!(json["truncated"], false);
}

#[tokio::test]
async fn an_empty_or_missing_folder_has_no_files() {
    let s = Scratch::new("lily-studio-test-");
    tokio::fs::create_dir(s.at("empty")).await.unwrap();
    assert!(list_folder(&s.at("empty")).await.files.is_empty());
    assert!(list_folder(&s.at("missing")).await.files.is_empty());
}

#[test]
fn is_inside_accepts_the_folder_and_its_descendants_only() {
    assert!(is_inside("/music", "/music"));
    assert!(is_inside("/music", "/music/a/b.ly"));
    assert!(!is_inside("/music", "/music-old/b.ly"));
    assert!(!is_inside("/music", "/music/../etc/b.ly"));
    assert!(!is_inside("/music", "/"));
}

#[test]
fn allows_the_open_folder_and_picked_files_nothing_else() {
    let mut access = Access::new();
    assert!(
        access
            .check("/music/a.ly")
            .unwrap_err()
            .contains("outside the open folder")
    );
    access.folder = Some("/music".into());
    assert_eq!(
        access.check("/music/sub/a.ly"),
        Ok(PathBuf::from("/music/sub/a.ly"))
    );
    assert!(
        access
            .check("/music/../secret/a.ly")
            .unwrap_err()
            .contains("outside the open folder")
    );
    assert!(
        access
            .check("/elsewhere/b.ly")
            .unwrap_err()
            .contains("outside the open folder")
    );
    access.allow_file("/elsewhere/b.ly");
    assert_eq!(
        access.check("/elsewhere/b.ly"),
        Ok(PathBuf::from("/elsewhere/b.ly"))
    );
    assert!(
        access
            .check("/elsewhere/c.ly")
            .unwrap_err()
            .contains("outside the open folder")
    );
}

#[test]
fn rejects_relative_paths_non_strings_and_files_that_are_not_scores() {
    let mut access = Access::new();
    access.folder = Some("/music".into());
    assert!(access.check("a.ly").unwrap_err().contains("absolute path"));
    assert!(
        access
            .check_value(&serde_json::json!(42))
            .unwrap_err()
            .contains("absolute path")
    );
    assert!(
        access
            .check("/music/notes.txt")
            .unwrap_err()
            .contains("Not a LilyPond file")
    );
}

#[tokio::test]
async fn write_score_and_read_score_round_trip_utf8_text() {
    let s = Scratch::new("lily-studio-test-");
    let file = s.at("round.ly");
    let text = "\\header { title = \"Für Elise — ♩\" }\r\n{ c4 }\n";
    write_score(&file, text).await.unwrap();
    assert_eq!(read_score(&file).await.unwrap(), text);
}

#[tokio::test]
async fn unused_name_counts_up_past_existing_files() {
    let s = Scratch::new("lily-studio-test-");
    let folder = s.at("names");
    tokio::fs::create_dir(&folder).await.unwrap();
    assert_eq!(
        unused_name(&folder, "Untitled", ".ly").await,
        folder.join("Untitled.ly")
    );
    s.write("names/Untitled.ly", "").await;
    s.write("names/Untitled 2.ly", "").await;
    assert_eq!(
        unused_name(&folder, "Untitled", ".ly").await,
        folder.join("Untitled 3.ly")
    );
}

#[tokio::test]
async fn create_from_template_writes_the_template_replacing_a_file_the_dialog_confirmed() {
    let s = Scratch::new("lily-studio-test-");
    let file = s.write("new/piece.ly", "old").await;
    create_from_template(&file, "piano").await.unwrap();
    assert_eq!(
        read_score(&file).await.unwrap(),
        TEMPLATES.iter().find(|t| t.id == "piano").unwrap().text
    );
    assert!(
        create_from_template(&file, "nope")
            .await
            .unwrap_err()
            .contains("Unknown template")
    );
}

#[tokio::test]
async fn every_template_compiles_without_errors_or_warnings() {
    let Some(lilypond) = common::lilypond("templates").await else {
        return;
    };
    let s = Scratch::new("lily-studio-test-");
    for template in TEMPLATES {
        let file = s.at(&format!("templates/{}.ly", template.id));
        tokio::fs::create_dir_all(file.parent().unwrap())
            .await
            .unwrap();
        create_from_template(&file, template.id).await.unwrap();
        let output = tokio::process::Command::new(&lilypond)
            .args(["--loglevel=WARNING", "-dno-point-and-click", "-o"])
            .arg(file.parent().unwrap())
            .arg(&file)
            .output()
            .await
            .unwrap();
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert_eq!(stderr.trim(), "", "{}: {stderr}", template.id);
    }
}

#[test]
fn templates_are_those_of_the_typescript() {
    assert_eq!(
        TEMPLATES
            .iter()
            .map(|t| (t.id, t.label))
            .collect::<Vec<_>>(),
        [
            ("melody", "Melody"),
            ("song", "Song with Lyrics"),
            ("piano", "Piano")
        ]
    );
    assert!(
        TEMPLATES
            .iter()
            .all(|t| t.text.starts_with("\\version \"2.24.0\"\n\n\\header {\n"))
    );
    assert_eq!(SAMPLE.name, "Ode to Joy.ly");
    assert!(
        SAMPLE
            .text
            .contains("  b4 b c d | d c b a | g g a b | b4. a8 a2 |\n")
    );
}
