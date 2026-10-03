//! The spike natively, through the same calls the C ABI makes.

use lily_engine_spike::layout::GLYPHS;
use lily_engine_spike::scheme::Interp;
use lily_engine_spike::{DONE, Engine, FILE, FONT_PACK, MODULE, MORE, NEEDS};

/// A font pack of squares: real outlines come from LilyPond's font at build time.
fn pack() -> Vec<u8> {
    GLYPHS
        .iter()
        .map(|g| format!("{g}\t300\tM0 0h300v100h-300z\n"))
        .collect::<String>()
        .into_bytes()
}

fn engine() -> Engine {
    let mut e = Engine::start(b"(define (twice x) (* 2 x))").expect("the prelude runs");
    e.put(MODULE, FONT_PACK, Some(&pack()));
    e
}

fn run(e: &mut Engine, root: &str) -> u32 {
    e.compile(root);
    loop {
        match e.step(1000.0) {
            MORE => continue,
            other => return other,
        }
    }
}

fn output<'a>(e: &'a Engine, name: &str) -> &'a str {
    let (_, data) = e
        .outputs()
        .iter()
        .find(|(n, _)| n == name)
        .unwrap_or_else(|| panic!("no output {name}"));
    std::str::from_utf8(data).expect("UTF-8")
}

fn eval(src: &str) -> String {
    let mut s = Interp::default();
    let v = s.eval_all(src).expect("evaluates");
    let mut out = String::new();
    s.write(&mut out, &v, true);
    out
}

#[test]
fn scheme_evaluates_what_scores_and_the_benchmark_use() {
    assert_eq!(
        eval("(define (fib n) (if (< n 2) n (+ (fib (- n 1)) (fib (- n 2))))) (fib 20)"),
        "6765"
    );
    assert_eq!(
        eval("(let loop ((i 0) (acc 0)) (if (= i 100000) acc (loop (+ i 1) (+ acc i))))"),
        "4999950000"
    );
    assert_eq!(
        eval("(define (make n) (lambda (x) (set! n (+ n x)) n)) (define c (make 10)) (c 1) (c 2)"),
        "13"
    );
    assert_eq!(
        eval("(map (lambda (x y) (* x y)) '(1 2 3) '(4 5 6))"),
        "(4 10 18)"
    );
    assert_eq!(
        eval("(let* ((a 1) (b (+ a 1))) (cond ((> a b) 'no) (else (list a b \"s\"))))"),
        "(1 2 \"s\")"
    );
    assert_eq!(eval("(define (f . xs) (apply + xs)) (f 1 2 3.5)"), "6.5");
    assert_eq!(eval("(assq 'b '((a . 1) (b . 2)))"), "(b . 2)");
    assert_eq!(
        eval("(string-append \"x\" (number->string (/ 1 4)))"),
        "\"x0.25\""
    );
}

#[test]
fn scheme_errors_are_reported_not_trapped() {
    let mut s = Interp::default();
    assert_eq!(
        s.eval_all("(car 1)").err().as_deref(),
        Some("car: wrong type (expecting pair)")
    );
    assert_eq!(
        s.eval_all("nope").err().as_deref(),
        Some("Unbound variable: nope")
    );
    let deep = s.eval_all("(define (down n) (if (= n 0) 0 (+ 1 (down (- n 1))))) (down 100000)");
    assert_eq!(deep.err().as_deref(), Some("Stack overflow"));
}

#[test]
fn t01_compiles_with_its_include_asked_for() {
    let fixtures = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../vscode/test/fixtures");
    let hello = std::fs::read(format!("{fixtures}/hello.ly")).expect("T01");
    let melody = std::fs::read(format!("{fixtures}/melody.ily")).expect("T01's include");
    let mut e = engine();
    e.put(FILE, "/s/hello.ly", Some(&hello));
    assert_eq!(run(&mut e, "/s/hello.ly"), NEEDS);
    assert_eq!(e.needs(), Some((FILE, "/s/melody.ily")));
    e.put(FILE, "/s/melody.ily", Some(&melody));
    assert_eq!(run(&mut e, "/s/hello.ly"), DONE);
    assert_eq!(output(&e, "diagnostics.json"), "[]");
    let svg = output(&e, "hello.svg");
    // T01's six notes, linked where melody.ily has them.
    assert_eq!(svg.matches("<a xlink:href=\"textedit://").count(), 6);
    assert!(
        svg.contains("<a xlink:href=\"textedit:///s/melody.ily:2:2:3\"><g transform=\"translate(")
    );
    assert!(svg.contains("<a xlink:href=\"textedit:///s/melody.ily:3:5:6\">"));
    // Each glyph is defined once.
    assert_eq!(svg.matches("<path id=\"noteheads.s2\"").count(), 1);
    assert!(svg.contains("\"restarts\":1"));
}

#[test]
fn a_missing_include_is_lilyponds_error() {
    let mut e = engine();
    e.put(FILE, "/s/a.ly", Some(b"\\include \"gone.ily\"\n{ c'4 }\n"));
    assert_eq!(run(&mut e, "/s/a.ly"), NEEDS);
    e.put(FILE, "/s/gone.ily", None);
    assert_eq!(run(&mut e, "/s/a.ly"), DONE);
    assert_eq!(
        output(&e, "diagnostics.json"),
        r#"[{"file":"/s/a.ly","line":1,"column":1,"severity":"error","message":"cannot find file: `gone.ily'"}]"#
    );
    assert_eq!(
        output(&e, "stderr"),
        "/s/a.ly:1:1: error: cannot find file: `gone.ily'\n\n\\include \"gone.ily\"\n"
    );
    assert!(!e.outputs().iter().any(|(n, _)| n.ends_with(".svg")));
}

#[test]
fn errors_point_at_the_token_with_tabs_expanded() {
    let mut e = engine();
    e.put(FILE, "/s/b.ly", Some(b"{\n\tc'4 \\nonsense d'\n}\n"));
    assert_eq!(run(&mut e, "/s/b.ly"), DONE);
    assert_eq!(
        output(&e, "stderr"),
        "/s/b.ly:2:13: error: unknown escaped string: `\\nonsense'\n\tc'4 \n            \\nonsense d'\n"
    );
}

#[test]
fn scheme_in_the_score_changes_what_is_drawn() {
    let mut e = engine();
    let src = "#(set-global-staff-size 16)\n\\header { title = #(string-append \"Fib \" (number->string (twice 5))) }\n{ c'4 d' e' f' }\n";
    e.put(FILE, "/s/c.ly", Some(src.as_bytes()));
    assert_eq!(run(&mut e, "/s/c.ly"), DONE);
    let svg = output(&e, "c.svg");
    assert!(svg.contains(">Fib 10</text>"));
    // 16 pt: more staff spaces across A4 than at 20 pt's 119.
    assert!(svg.contains("viewBox=\"0 0 149."), "{}", &svg[..200]);
    // The next compile starts from the image again: no staff size, no title.
    e.put(FILE, "/s/c.ly", Some(b"{ c'4 }"));
    assert_eq!(run(&mut e, "/s/c.ly"), DONE);
    assert!(output(&e, "c.svg").contains("viewBox=\"0 0 119."));
}

#[test]
fn relative_octaves_accidentals_and_rests() {
    let mut e = engine();
    e.put(
        FILE,
        "/s/d.ly",
        Some(b"\\relative c'' { \\key g \\major \\time 3/4 g4 a b | fis2 f4 | r2. | c,,1 }"),
    );
    assert_eq!(run(&mut e, "/s/d.ly"), DONE);
    let svg = output(&e, "d.svg");
    assert_eq!(svg.matches("textedit://").count(), 7);
    // f natural against the key's f sharp; the key's own sharp drawn once.
    assert_eq!(svg.matches("#accidentals.natural").count(), 1);
    assert_eq!(svg.matches("#accidentals.sharp").count(), 1);
    assert!(svg.contains("#rests.1"));
}

#[test]
fn a_long_score_breaks_into_systems_and_pages() {
    let mut e = engine();
    let bars = "c'8 d' e' f' g'4 a'16 b' c'' d'' | ".repeat(150);
    e.put(FILE, "/s/long.ly", Some(format!("{{ {bars} }}").as_bytes()));
    assert_eq!(run(&mut e, "/s/long.ly"), DONE);
    let pages: Vec<_> = e
        .outputs()
        .iter()
        .filter(|(n, _)| n.ends_with(".svg"))
        .map(|(n, _)| n.as_str())
        .collect();
    assert!(pages.len() >= 2, "{pages:?}");
    assert_eq!(pages[0], "long-1.svg");
    let links: usize = e
        .outputs()
        .iter()
        .filter(|(n, _)| n.ends_with(".svg"))
        .map(|(_, d)| {
            std::str::from_utf8(d)
                .unwrap()
                .matches("textedit://")
                .count()
        })
        .sum();
    assert_eq!(links, 150 * 9);
}

#[test]
fn a_step_returns_when_its_budget_is_spent() {
    let mut e = engine();
    e.put(FILE, "/s/e.ly", Some(b"{ c'4 }"));
    e.compile("/s/e.ly");
    // One pass per step at a budget of nothing: parse, layout, the page, then the other outputs.
    for _ in 0..3 {
        assert_eq!(e.step(0.0), MORE);
    }
    assert_eq!(e.step(0.0), DONE);
    assert!(output(&e, "e.svg").contains("\"steps\":4"));
}
