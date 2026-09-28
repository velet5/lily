//! From test/compile/rootFile.test.ts.

mod common;

use std::path::{Path, PathBuf};

use lily_engrave::root_file::{
    IncludeOptions, include_closure, include_dirs_from_args, include_graph, include_tokens,
    parse_includes, roots_including,
};

#[test]
fn finds_includes_with_or_without_a_space_before_the_name() {
    let source = "\\version \"2.26.0\"\n\\include \"parts/a.ily\"\n\\include\"b.ily\"\n{ c }\n";
    assert_eq!(parse_includes(source), ["parts/a.ily", "b.ily"]);
}

#[test]
fn skips_includes_in_comments() {
    let source = [
        "% \\include \"line.ily\"",
        "%{ \\include \"block.ily\"",
        "   \\include \"block2.ily\" %}",
        "\\include \"real.ily\" % \\include \"trailing.ily\"",
    ]
    .join("\n");
    assert_eq!(parse_includes(&source), ["real.ily"]);
}

#[test]
fn a_percent_sign_or_an_include_inside_a_string_is_text() {
    let source = "title = \"100% \\include \\\"no.ily\\\"\"\n\\include \"yes.ily\"\n";
    assert_eq!(parse_includes(source), ["yes.ily"]);
}

#[test]
fn unescapes_the_name() {
    assert_eq!(
        parse_includes("\\include \"my \\\"best\\\" part.ily\""),
        ["my \"best\" part.ily"]
    );
}

#[test]
fn survives_unterminated_comments_and_strings() {
    assert_eq!(
        parse_includes("\\include \"a.ily\"\n%{ \\include \"b.ily\""),
        ["a.ily"]
    );
    assert_eq!(
        parse_includes("\\include \"a.ily\"\n\"open \\include \"b.ily"),
        ["a.ily"]
    );
}

#[test]
fn a_computed_include_has_no_name_and_offsets_are_bytes() {
    let source = "é \\include \"a.ily\" \\include #(x)";
    let tokens = include_tokens(source);
    assert_eq!(tokens.len(), 2);
    assert_eq!(&source[tokens[0].start..tokens[0].end], "\"a.ily\"");
    assert_eq!(tokens[1].name, None);
    assert_eq!(&source[tokens[1].start..tokens[1].end], "\\include");
}

#[test]
fn include_dirs_understand_every_spelling_lilypond_accepts() {
    let args: Vec<String> = [
        "-dno-point-and-click",
        "-I",
        "lib",
        "-Iother",
        "--include=/abs dir",
        "--include",
        "x",
    ]
    .into_iter()
    .map(String::from)
    .collect();
    assert_eq!(
        include_dirs_from_args(&args, Path::new("/scores")),
        ["/scores/lib", "/scores/other", "/abs dir", "/scores/x"].map(PathBuf::from)
    );
    assert_eq!(
        include_dirs_from_args(&["-I".to_owned()], Path::new("/scores")),
        Vec::<PathBuf>::new()
    );
}

async fn graph_fixture() -> common::Scratch {
    let scratch = common::Scratch::new("lily-roots-");
    for (name, text) in [
        (
            "song.ly",
            "\\include \"english.ly\"\n\\include \"parts/melody.ily\"\n\\include \"coda.ily\"\n",
        ),
        // Relative to the including file, and relative to the root [verified 2.26].
        (
            "parts/melody.ily",
            "\\include \"shared.ily\"\n\\include \"parts/lyrics.ily\"\n",
        ),
        ("parts/shared.ily", "\\include \"melody.ily\"\n"),
        ("parts/lyrics.ily", "words = \\lyricmode { la }\n"),
        ("coda.ily", "coda = { c1 }\n"),
        (
            "hymn.ly",
            "\\include \"parts/shared.ily\"\n\\include \"house-style.ily\"\n",
        ),
        ("solo.ly", "{ c }\n"),
        ("lib/house-style.ily", "\\paper { }\n"),
    ] {
        scratch.write(name, text).await;
    }
    scratch
}

fn sorted(files: impl IntoIterator<Item = PathBuf>) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = files.into_iter().collect();
    files.sort();
    files
}

#[tokio::test]
async fn follows_nested_includes_tolerates_cycles_and_ignores_library_files() {
    let s = graph_fixture().await;
    let closure = include_closure(&s.at("song.ly"), &IncludeOptions::default()).await;
    assert_eq!(
        sorted(closure),
        sorted(
            [
                "coda.ily",
                "parts/lyrics.ily",
                "parts/melody.ily",
                "parts/shared.ily",
                "song.ly"
            ]
            .map(|f| s.at(f))
        )
    );
}

#[tokio::test]
async fn searches_the_include_directories() {
    let s = graph_fixture().await;
    assert!(
        !include_closure(&s.at("hymn.ly"), &IncludeOptions::default())
            .await
            .contains(&s.at("lib/house-style.ily"))
    );
    let options = IncludeOptions {
        include_dirs: vec![s.at("lib")],
        ..Default::default()
    };
    assert!(
        include_closure(&s.at("hymn.ly"), &options)
            .await
            .contains(&s.at("lib/house-style.ily"))
    );
}

#[tokio::test]
async fn include_graph_lists_where_the_includes_that_were_not_found_would_be() {
    let s = graph_fixture().await;
    let graph = include_graph(&s.at("hymn.ly"), &IncludeOptions::default()).await;
    assert_eq!(
        sorted(graph.files),
        sorted(
            [
                "hymn.ly",
                "parts/lyrics.ily",
                "parts/melody.ily",
                "parts/shared.ily"
            ]
            .map(|f| s.at(f))
        )
    );
    // house-style.ily from the root's directory; melody.ily from parts/ is found, so not missing.
    assert_eq!(graph.missing, vec![s.at("house-style.ily")]);
    let with_lib = include_graph(
        &s.at("hymn.ly"),
        &IncludeOptions {
            include_dirs: vec![s.at("lib")],
            ..Default::default()
        },
    )
    .await;
    assert_eq!(with_lib.missing, Vec::<PathBuf>::new());
}

#[tokio::test]
async fn a_root_that_does_not_exist_is_its_own_closure() {
    let s = graph_fixture().await;
    assert_eq!(
        sorted(include_closure(&s.at("gone.ly"), &IncludeOptions::default()).await),
        vec![s.at("gone.ly")]
    );
}

#[tokio::test]
async fn roots_including_returns_the_roots_that_compile_a_file() {
    let s = graph_fixture().await;
    let roots = ["song.ly", "hymn.ly", "solo.ly"].map(|f| s.at(f));
    let none = |_: &Path| IncludeOptions::default();
    assert_eq!(
        roots_including(&s.at("parts/shared.ily"), &roots, none).await,
        roots[..2]
    );
    assert_eq!(
        roots_including(&s.at("coda.ily"), &roots, none).await,
        [roots[0].clone()]
    );
    assert_eq!(
        roots_including(&s.at("solo.ly"), &roots, none).await,
        [roots[2].clone()]
    );
    assert_eq!(
        roots_including(&s.at("lib/house-style.ily"), &roots, none).await,
        Vec::<PathBuf>::new()
    );
    let hymn = s.at("hymn.ly");
    let lib = s.at("lib");
    let with_lib = |root: &Path| {
        if root == hymn {
            IncludeOptions {
                include_dirs: vec![lib.clone()],
                ..Default::default()
            }
        } else {
            IncludeOptions::default()
        }
    };
    assert_eq!(
        roots_including(&s.at("lib/house-style.ily"), &roots, with_lib).await,
        [s.at("hymn.ly")]
    );
}

#[tokio::test]
async fn buffers_add_edges_and_conservative_roots_reach_everything() {
    let s = graph_fixture().await;
    let buffers: lily_engrave::SourceBuffers =
        [(s.at("solo.ly"), "\\include \"coda.ily\"\n".to_owned())]
            .into_iter()
            .collect();
    let with = |_: &Path| IncludeOptions {
        buffers: Some(buffers.clone()),
        ..Default::default()
    };
    assert_eq!(
        roots_including(&s.at("coda.ily"), &[s.at("solo.ly")], with).await,
        [s.at("solo.ly")]
    );
    s.write("computed.ly", "\\include #(string-append \"a\" \".ily\")\n")
        .await;
    let conservative = |_: &Path| IncludeOptions {
        conservative: true,
        ..Default::default()
    };
    assert_eq!(
        roots_including(&s.at("coda.ily"), &[s.at("computed.ly")], conservative).await,
        [s.at("computed.ly")]
    );
}

#[tokio::test]
async fn matches_a_file_saved_under_another_spelling_of_its_path() {
    let s = graph_fixture().await;
    let link = s.at("link");
    std::os::unix::fs::symlink(s.at("parts"), &link).expect("symlink");
    assert_eq!(
        roots_including(&link.join("lyrics.ily"), &[s.at("song.ly")], |_| {
            IncludeOptions::default()
        })
        .await,
        [s.at("song.ly")]
    );
}
