//! The spike's LilyPond: a hand-written recursive descent over the source, in
//! the shape of chapter 02's parser but for one staff of notes, rests and
//! durations, `\relative`, variables, `\include`, `\header`, `\clef`,
//! `\time`, `\key`, `\bar` and breaks, and `#`/`$` Scheme. It re-parses
//! everything on every compile; chapter 02 §5.7 re-parses only the edit.

use crate::scheme::{Interp, Value};
use std::collections::BTreeMap;
use std::rc::Rc;

/// Ticks in a whole note: dotted 64ths stay whole numbers.
pub const WHOLE: u32 = 1536;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Pitch {
    /// 0 for c to 6 for b.
    pub step: i8,
    /// Semitones: -2 to 2.
    pub alter: i8,
    /// LilyPond's: `c` is 0, `c'` (middle C) is 1.
    pub octave: i8,
}

impl Pitch {
    /// Diatonic steps from the c of octave 0.
    pub fn steps(self) -> i32 {
        self.octave as i32 * 7 + self.step as i32
    }
}

/// A byte offset in one of the parse's files.
#[derive(Clone, Copy, Debug)]
pub struct Origin {
    pub file: u16,
    pub at: u32,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Clef {
    Treble,
    Bass,
    Alto,
}

impl Clef {
    /// Diatonic steps (as `Pitch::steps`) of the staff's middle line.
    pub fn middle(self) -> i32 {
        match self {
            Clef::Treble => 13, // b'
            Clef::Bass => 1,    // d
            Clef::Alto => 7,    // c'
        }
    }
}

#[derive(Clone, Debug)]
pub enum Item {
    Note {
        pitch: Pitch,
        log: u8,
        dots: u8,
        len: u32,
        forced: bool,
        at: Origin,
    },
    Rest {
        log: u8,
        dots: u8,
        len: u32,
        at: Origin,
    },
    Skip {
        len: u32,
    },
    Clef(Clef),
    Time(u8, u8),
    /// Sharps (positive) or flats (negative) of the key.
    Key(i8),
    Bar(Rc<str>),
    Break {
        page: bool,
    },
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Severity {
    Error,
    Warning,
}

#[derive(Debug)]
pub struct Diag {
    pub file: u16,
    pub at: u32,
    pub severity: Severity,
    pub message: String,
}

#[derive(Default)]
pub struct Score {
    pub title: Option<String>,
    pub composer: Option<String>,
    pub music: Vec<Item>,
}

#[derive(Clone)]
enum Var {
    Music(Rc<[Item]>),
    /// A string or a Scheme value: the spike does not use them in music.
    Other,
}

/// What a parse needs from the host before it can go on: a file it was not given.
pub struct Needs(pub String);

pub struct Parsed {
    pub score: Score,
    /// The files read, by index: what an `Origin` names.
    pub sources: Vec<(String, Rc<str>)>,
    pub diags: Vec<Diag>,
    /// Of the parse's time, what the Scheme took.
    pub scheme_ms: f64,
}

pub struct Parser<'a> {
    files: &'a BTreeMap<String, Option<Rc<str>>>,
    scheme: &'a mut Interp,
    sources: Vec<(String, Rc<str>)>,
    diags: Vec<Diag>,
    vars: BTreeMap<String, Var>,
    score: Score,
    depth: u32,
    scheme_ms: f64,
}

struct Cursor {
    file: u16,
    src: Rc<str>,
    pos: usize,
}

impl Cursor {
    fn bytes(&self) -> &[u8] {
        self.src.as_bytes()
    }
    fn peek(&self) -> Option<u8> {
        self.bytes().get(self.pos).copied()
    }
    fn peek_at(&self, k: usize) -> Option<u8> {
        self.bytes().get(self.pos + k).copied()
    }
    fn at(&self) -> Origin {
        Origin {
            file: self.file,
            at: self.pos as u32,
        }
    }

    /// Skips white space and `%` and `%{ … %}` comments.
    fn skip(&mut self) {
        while let Some(c) = self.peek() {
            if c.is_ascii_whitespace() {
                self.pos += 1;
            } else if c == b'%' {
                if self.peek_at(1) == Some(b'{') {
                    let rest = &self.src[self.pos + 2..];
                    self.pos = rest
                        .find("%}")
                        .map_or(self.src.len(), |k| self.pos + 2 + k + 2);
                } else {
                    while self.peek().is_some_and(|c| c != b'\n') {
                        self.pos += 1;
                    }
                }
            } else {
                break;
            }
        }
    }

    fn word(&mut self) -> &str {
        let start = self.pos;
        while self.peek().is_some_and(|c| {
            c.is_ascii_alphabetic()
                || c == b'-' && self.peek_at(1).is_some_and(|d| d.is_ascii_alphabetic())
        }) {
            self.pos += 1;
        }
        &self.src[start..self.pos]
    }

    fn number(&mut self) -> Option<u32> {
        let start = self.pos;
        while self.peek().is_some_and(|c| c.is_ascii_digit()) {
            self.pos += 1;
        }
        let mut n: u32 = 0;
        for c in self.src[start..self.pos].bytes() {
            n = n.saturating_mul(10).saturating_add((c - b'0') as u32);
        }
        (self.pos > start).then_some(n)
    }

    fn string(&mut self) -> Option<String> {
        if self.peek() != Some(b'"') {
            return None;
        }
        let mut s = String::new();
        let mut chars = self.src[self.pos + 1..].char_indices();
        while let Some((k, c)) = chars.next() {
            match c {
                '"' => {
                    self.pos += 1 + k + 1;
                    return Some(s);
                }
                '\\' => {
                    if let Some((_, n)) = chars.next() {
                        s.push(n)
                    }
                }
                _ => s.push(c),
            }
        }
        self.pos = self.src.len();
        Some(s)
    }

    fn eat(&mut self, c: u8) -> bool {
        self.skip();
        let hit = self.peek() == Some(c);
        if hit {
            self.pos += 1;
        }
        hit
    }

    /// Skips a balanced `{ … }`.
    fn skip_block(&mut self) {
        self.skip();
        if self.peek() != Some(b'{') {
            return;
        }
        let mut depth = 0;
        while let Some(c) = self.peek() {
            self.pos += 1;
            match c {
                b'{' => depth += 1,
                b'}' => {
                    depth -= 1;
                    if depth == 0 {
                        return;
                    }
                }
                b'"' => {
                    self.pos -= 1;
                    self.string();
                }
                b'%' => {
                    self.pos -= 1;
                    self.skip();
                }
                _ => {}
            }
        }
    }
}

/// Dynamics and articulations the spike reads and does not draw.
const IGNORED: &[&str] = &[
    "p", "pp", "ppp", "mp", "mf", "f", "ff", "fff", "sf", "sfz", "fp", "staccato", "accent",
    "fermata", "tenuto", "trill",
];

impl<'a> Parser<'a> {
    pub fn new(files: &'a BTreeMap<String, Option<Rc<str>>>, scheme: &'a mut Interp) -> Self {
        Parser {
            files,
            scheme,
            sources: Vec::new(),
            diags: Vec::new(),
            vars: BTreeMap::new(),
            score: Score::default(),
            depth: 0,
            scheme_ms: 0.0,
        }
    }

    pub fn parse(mut self, root: &str) -> Result<Parsed, Needs> {
        match self.files.get(root) {
            Some(Some(src)) => {
                let mut c = self.open(root, src.clone());
                self.toplevel(&mut c, None)?;
            }
            Some(None) => self.diags.push(Diag {
                file: 0,
                at: 0,
                severity: Severity::Error,
                message: cannot_find(root),
            }),
            None => return Err(Needs(root.into())),
        }
        Ok(Parsed {
            score: self.score,
            sources: self.sources,
            diags: self.diags,
            scheme_ms: self.scheme_ms,
        })
    }

    fn open(&mut self, path: &str, src: Rc<str>) -> Cursor {
        self.sources.push((path.into(), src.clone()));
        Cursor {
            file: (self.sources.len() - 1) as u16,
            src,
            pos: 0,
        }
    }

    fn error(&mut self, at: Origin, message: String) {
        self.diags.push(Diag {
            file: at.file,
            at: at.at,
            severity: Severity::Error,
            message,
        });
    }

    /// The items of a file, or until the `}` that closes a `\score`.
    fn toplevel(&mut self, c: &mut Cursor, close: Option<u8>) -> Result<(), Needs> {
        loop {
            c.skip();
            let at = c.at();
            let Some(ch) = c.peek() else { return Ok(()) };
            if Some(ch) == close {
                c.pos += 1;
                return Ok(());
            }
            match ch {
                b'\\' => {
                    let save = c.pos;
                    c.pos += 1;
                    let word = c.word().to_owned();
                    match word.as_str() {
                        "version" => {
                            c.skip();
                            c.string();
                        }
                        "header" => self.header(c),
                        "include" => {
                            c.skip();
                            match c.string() {
                                Some(name) => self.include(c, at, &name)?,
                                None => self.error(at, "\\include needs a file name".into()),
                            }
                        }
                        "score" => {
                            if c.eat(b'{') {
                                self.toplevel(c, Some(b'}'))?;
                            }
                        }
                        "paper" | "layout" | "midi" => c.skip_block(),
                        _ => {
                            c.pos = save;
                            let music = self.music(c, &mut None)?;
                            self.score.music.extend(music);
                        }
                    }
                }
                b'{' | b'<' => {
                    let music = self.music(c, &mut None)?;
                    self.score.music.extend(music);
                }
                b'#' | b'$' => {
                    self.scheme(c);
                }
                c0 if c0.is_ascii_alphabetic() => {
                    let name = c.word().to_owned();
                    if !c.eat(b'=') {
                        self.error(at, unexpected(&name));
                        continue;
                    }
                    c.skip();
                    let var = match c.peek() {
                        Some(b'"') => {
                            c.string();
                            Var::Other
                        }
                        Some(b'#' | b'$') => {
                            self.scheme(c);
                            Var::Other
                        }
                        _ => Var::Music(self.music(c, &mut None)?.into()),
                    };
                    self.vars.insert(name, var);
                }
                _ => {
                    c.pos += char_len(&c.src, c.pos);
                    self.error(at, unexpected(&c.src[at.at as usize..c.pos]));
                }
            }
        }
    }

    fn include(&mut self, c: &mut Cursor, at: Origin, name: &str) -> Result<(), Needs> {
        // Relative to the including file, as LilyPond's default `-drelative-includes`.
        let path = match name.starts_with('/') {
            true => name.to_owned(),
            false => {
                let base = &self.sources[c.file as usize].0;
                let dir = base.rfind('/').map_or("", |i| &base[..=i]);
                let mut p = String::from(dir);
                p.push_str(name);
                p
            }
        };
        match self.files.get(&path) {
            None => Err(Needs(path)),
            Some(None) => {
                self.error(at, cannot_find(name));
                Ok(())
            }
            Some(Some(src)) => {
                if self.depth > 20 {
                    self.error(at, "\\include nested too deeply".into());
                    return Ok(());
                }
                self.depth += 1;
                let mut inner = self.open(&path, src.clone());
                let result = self.toplevel(&mut inner, None);
                self.depth -= 1;
                result
            }
        }
    }

    fn header(&mut self, c: &mut Cursor) {
        if !c.eat(b'{') {
            return;
        }
        loop {
            c.skip();
            match c.peek() {
                None => return,
                Some(b'}') => {
                    c.pos += 1;
                    return;
                }
                _ => {}
            }
            let at = c.at();
            let key = c.word().to_owned();
            if key.is_empty() || !c.eat(b'=') {
                c.pos += char_len(&c.src, c.pos).max(1);
                self.error(at, "syntax error in \\header".into());
                continue;
            }
            c.skip();
            let value = match c.peek() {
                Some(b'"') => c.string(),
                Some(b'#' | b'$') => match self.scheme(c) {
                    Some(Value::Str(s)) => Some(s.to_string()),
                    _ => None,
                },
                _ => {
                    c.word();
                    None
                }
            };
            match key.as_str() {
                "title" => self.score.title = value,
                "composer" => self.score.composer = value,
                _ => {}
            }
        }
    }

    /// `#datum` or `$datum` at the cursor, evaluated.
    fn scheme(&mut self, c: &mut Cursor) -> Option<Value> {
        let at = c.at();
        let start = c.pos + 1;
        let read = self.scheme.read(&c.src, start);
        match read {
            Ok((datum, end)) => {
                c.pos = end;
                let started = crate::now();
                let result = self.scheme.eval(&datum);
                self.scheme_ms += crate::now() - started;
                match result {
                    Ok(v) => Some(v),
                    Err(message) => {
                        self.error(at, message);
                        None
                    }
                }
            }
            Err(message) => {
                c.pos = c.src.len();
                self.error(at, message);
                None
            }
        }
    }

    /// One music expression. `rel` is the pitch the next note is relative to, inside `\relative`.
    fn music(&mut self, c: &mut Cursor, rel: &mut Option<Pitch>) -> Result<Vec<Item>, Needs> {
        c.skip();
        let at = c.at();
        match c.peek() {
            Some(b'{') => {
                c.pos += 1;
                self.sequence(c, rel)
            }
            Some(b'<') if c.peek_at(1) == Some(b'<') => {
                self.error(
                    at,
                    "simultaneous music is not in the spike: one staff only".into(),
                );
                // Skip to the matching >>.
                let rest = &c.src[c.pos..];
                c.pos = rest.find(">>").map_or(c.src.len(), |k| c.pos + k + 2);
                Ok(Vec::new())
            }
            Some(b'\\') => {
                c.pos += 1;
                let word = c.word().to_owned();
                match word.as_str() {
                    "relative" => {
                        c.skip();
                        // Without a pitch, the first note's marks are absolute: relative to f.
                        let mut start = Some(Pitch {
                            step: 3,
                            alter: 0,
                            octave: 0,
                        });
                        if c.peek().is_some_and(|ch| (b'a'..=b'g').contains(&ch)) {
                            let save = c.pos;
                            let name = c.word().to_owned();
                            match note_name(&name) {
                                Some((step, alter)) => {
                                    let octave = marks(c);
                                    start = Some(Pitch {
                                        step,
                                        alter,
                                        octave,
                                    });
                                }
                                None => c.pos = save,
                            }
                        }
                        self.music(c, &mut start)
                    }
                    "new" | "context" => {
                        c.skip();
                        c.word();
                        if c.eat(b'=') {
                            c.skip();
                            c.string();
                        }
                        c.skip();
                        if c.src[c.pos..].starts_with("\\with") {
                            c.pos += 5;
                            c.skip_block();
                        }
                        self.music(c, rel)
                    }
                    _ => match self.vars.get(&word).cloned() {
                        Some(Var::Music(items)) => Ok(items.to_vec()),
                        _ => {
                            self.error(at, unknown_escaped(&word));
                            Ok(Vec::new())
                        }
                    },
                }
            }
            _ => {
                c.pos += char_len(&c.src, c.pos).max(1);
                self.error(at, unexpected(&c.src[at.at as usize..c.pos]));
                Ok(Vec::new())
            }
        }
    }

    fn sequence(&mut self, c: &mut Cursor, rel: &mut Option<Pitch>) -> Result<Vec<Item>, Needs> {
        let mut out = Vec::new();
        let mut last_log = 2u8;
        let mut last_dots = 0u8;
        loop {
            c.skip();
            let at = c.at();
            let Some(ch) = c.peek() else {
                self.error(at, "syntax error, unexpected end of input".into());
                return Ok(out);
            };
            match ch {
                b'}' => {
                    c.pos += 1;
                    return Ok(out);
                }
                b'{' | b'<' => out.extend(self.music(c, rel)?),
                b'|' | b'~' | b'(' | b')' | b'[' | b']' => c.pos += 1,
                b'-' | b'^' | b'_' => {
                    // An articulation: -. -> -^ -- and the like.
                    c.pos += 1;
                    if c.peek().is_some_and(|x| !x.is_ascii_whitespace()) {
                        c.pos += 1;
                    }
                }
                b'#' | b'$' => {
                    self.scheme(c);
                }
                b'\\' => {
                    let save = c.pos;
                    c.pos += 1;
                    if matches!(c.peek(), Some(b'(' | b')' | b'<' | b'>' | b'!')) {
                        c.pos += 1;
                        continue;
                    }
                    let word = c.word().to_owned();
                    match word.as_str() {
                        "clef" => {
                            c.skip();
                            let name = match c.peek() {
                                Some(b'"') => c.string().unwrap_or_default(),
                                _ => c.word().to_owned(),
                            };
                            match name.as_str() {
                                "treble" | "violin" | "G" => out.push(Item::Clef(Clef::Treble)),
                                "bass" | "F" => out.push(Item::Clef(Clef::Bass)),
                                "alto" | "C" => out.push(Item::Clef(Clef::Alto)),
                                _ => self.error(at, {
                                    let mut m = String::from("unknown clef type `");
                                    m.push_str(&name);
                                    m.push('\'');
                                    m
                                }),
                            }
                        }
                        "time" => {
                            c.skip();
                            let n = c.number().unwrap_or(4);
                            let d = if c.eat(b'/') {
                                c.number().unwrap_or(4)
                            } else {
                                4
                            };
                            out.push(Item::Time(n.clamp(1, 32) as u8, d.clamp(1, 64) as u8));
                        }
                        "key" => {
                            c.skip();
                            let name = c.word().to_owned();
                            c.skip();
                            let mode = if c.peek() == Some(b'\\') {
                                c.pos += 1;
                                c.word().to_owned()
                            } else {
                                String::new()
                            };
                            match note_name(&name) {
                                Some((step, alter)) => {
                                    out.push(Item::Key(key_of(step, alter, mode == "minor")))
                                }
                                None => self.error(at, "\\key needs a pitch".into()),
                            }
                        }
                        "bar" => {
                            c.skip();
                            let kind = c.string().unwrap_or_else(|| "|".into());
                            out.push(Item::Bar(kind.into()));
                        }
                        "break" => out.push(Item::Break { page: false }),
                        "pageBreak" => out.push(Item::Break { page: true }),
                        "tempo" => {
                            // \tempo 4 = 96, or a text: read and not drawn.
                            c.skip();
                            c.string();
                            c.skip();
                            if c.number().is_some() {
                                c.eat(b'=');
                                c.skip();
                                c.number();
                            }
                        }
                        w if IGNORED.contains(&w) => {}
                        _ => {
                            c.pos = save;
                            out.extend(self.music(c, rel)?);
                        }
                    }
                }
                ch if ch.is_ascii_alphabetic() => {
                    let name = c.word().to_owned();
                    let kind = match name.as_str() {
                        "r" => Some(None),
                        "s" => Some(None),
                        _ => note_name(&name).map(Some),
                    };
                    let Some(pitch) = kind else {
                        self.error(at, unexpected(&name));
                        continue;
                    };
                    let mut octave = marks(c);
                    let forced = matches!(c.peek(), Some(b'!' | b'?'));
                    if forced {
                        c.pos += 1;
                    }
                    if let Some(d) = c.number() {
                        match d {
                            1 | 2 | 4 | 8 | 16 | 32 | 64 => last_log = d.trailing_zeros() as u8,
                            _ => self.error(at, "not a duration".into()),
                        }
                        last_dots = 0;
                        while c.peek() == Some(b'.') {
                            c.pos += 1;
                            last_dots += 1;
                        }
                    }
                    let base = WHOLE >> last_log;
                    let len = (0..=last_dots.min(4)).map(|k| base >> k).sum();
                    let (log, dots) = (last_log, last_dots);
                    match (name.as_str(), pitch) {
                        ("s", _) => out.push(Item::Skip { len }),
                        (_, None) => out.push(Item::Rest { log, dots, len, at }),
                        (_, Some((step, alter))) => {
                            if let Some(prev) = rel {
                                // The octave that puts the note within a fourth of the previous one.
                                let base = prev.steps();
                                let mut d = (step as i32 - base).rem_euclid(7);
                                if d > 3 {
                                    d -= 7;
                                }
                                let steps = base + d + 7 * octave as i32;
                                octave = steps.div_euclid(7) as i8;
                            }
                            let pitch = Pitch {
                                step,
                                alter,
                                octave,
                            };
                            if rel.is_some() {
                                *rel = Some(pitch);
                            }
                            out.push(Item::Note {
                                pitch,
                                log,
                                dots,
                                len,
                                forced,
                                at,
                            });
                        }
                    }
                }
                _ => {
                    c.pos += char_len(&c.src, c.pos).max(1);
                    self.error(at, unexpected(&c.src[at.at as usize..c.pos]));
                }
            }
        }
    }
}

/// `'` and `,` after a pitch: octaves up or down.
fn marks(c: &mut Cursor) -> i8 {
    let mut o = 0i8;
    loop {
        match c.peek() {
            Some(b'\'') => o += 1,
            Some(b',') => o -= 1,
            _ => return o,
        }
        c.pos += 1;
    }
}

/// Dutch note names: c d e f g a b with -is and -es (and as, es, ases, eses).
fn note_name(w: &str) -> Option<(i8, i8)> {
    let b = w.as_bytes();
    let step = match b.first()? {
        b'c' => 0,
        b'd' => 1,
        b'e' => 2,
        b'f' => 3,
        b'g' => 4,
        b'a' => 5,
        b'b' => 6,
        _ => return None,
    };
    let mut rest = &w[1..];
    let mut alter = 0i8;
    if matches!(step, 2 | 5) && rest.starts_with('s') && !rest.starts_with("is") {
        alter = -1;
        rest = &rest[1..];
    }
    while !rest.is_empty() {
        if let Some(r) = rest.strip_prefix("is") {
            alter += 1;
            rest = r;
        } else {
            let r = rest.strip_prefix("es")?;
            alter -= 1;
            rest = r;
        }
    }
    (-2..=2).contains(&alter).then_some((step, alter))
}

/// Sharps or flats of a major or minor key on `step` with `alter`.
fn key_of(step: i8, alter: i8, minor: bool) -> i8 {
    // Fifths from C of each natural step: c 0, d 2, e 4, f -1, g 1, a 3, b 5.
    const FIFTHS: [i8; 7] = [0, 2, 4, -1, 1, 3, 5];
    FIFTHS[step as usize] + 7 * alter - if minor { 3 } else { 0 }
}

fn char_len(s: &str, at: usize) -> usize {
    s[at..].chars().next().map_or(0, char::len_utf8)
}

fn unexpected(token: &str) -> String {
    let mut m = String::from("syntax error, unexpected `");
    m.push_str(token);
    m.push('\'');
    m
}

fn unknown_escaped(word: &str) -> String {
    let mut m = String::from("unknown escaped string: `\\");
    m.push_str(word);
    m.push('\'');
    m
}

fn cannot_find(name: &str) -> String {
    let mut m = String::from("cannot find file: `");
    m.push_str(name);
    m.push('\'');
    m
}
