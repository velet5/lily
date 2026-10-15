//! One staff, laid out: columns spaced by duration, bar lines where the
//! measures end, the lines broken by a small dynamic programme over the
//! measures, pages filled from the top. Units are staff spaces, y downwards.
//! No beams, slurs, ties, collisions or vertical spacing: chapter 05's work,
//! which the timings of 09-spike.md leave room for.

use crate::font::Font;
use crate::music::{Clef, Item, Origin, Pitch, Score, WHOLE};
use std::rc::Rc;

pub enum Draw {
    Glyph {
        name: &'static str,
        x: f64,
        y: f64,
        link: Option<Origin>,
    },
    /// From (x1, y1) to (x2, y2), `w` thick.
    Line {
        x1: f64,
        y1: f64,
        x2: f64,
        y2: f64,
        w: f64,
    },
    Text {
        x: f64,
        y: f64,
        size: f64,
        text: Rc<str>,
        anchor: &'static str,
    },
}

pub struct Page {
    pub width: f64,
    pub height: f64,
    pub draws: Vec<Draw>,
}

pub struct Layout {
    pub pages: Vec<Page>,
    pub systems: usize,
    pub events: usize,
}

/// Millimetres per staff space at 20 pt; other staff sizes scale it.
const MM_PER_SPACE_20: f64 = 25.4 / 72.27 * 5.0;
const STAFF_LINE: f64 = 0.1;
const STEM: f64 = 0.13;
const SYSTEM_DISTANCE: f64 = 13.0;

enum Col {
    Note {
        pitch: Pitch,
        log: u8,
        dots: u8,
        len: u32,
        acc: Option<i8>,
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
    Key(i8),
    Time(u8, u8),
}

struct Measure {
    cols: Vec<Col>,
    /// What is in force where the measure starts: what a system starting here draws first.
    clef: Clef,
    key: i8,
    time: Option<(u8, u8)>,
    bar: Rc<str>,
    /// A `\break` (false) or `\pageBreak` (true) after it.
    brk: Option<bool>,
    width: f64,
}

pub fn layout(score: &Score, font: &Font, staff_size: f64) -> Layout {
    let (measures, shortest) = measures(&score.music, font);
    let space_mm = MM_PER_SPACE_20 * staff_size / 20.0;
    let (width, height) = (210.0 / space_mm, 297.0 / space_mm);
    let (left, right, top, bottom) = (
        15.0 / space_mm,
        15.0 / space_mm,
        10.0 / space_mm,
        10.0 / space_mm,
    );
    let line_width = width - left - right;
    let lines = break_lines(&measures, font, line_width);
    let events = measures
        .iter()
        .flat_map(|m| &m.cols)
        .filter(|c| matches!(c, Col::Note { .. } | Col::Rest { .. }))
        .count();

    let mut pages = vec![Page {
        width,
        height,
        draws: Vec::new(),
    }];
    let mut y = top + 4.0;
    if let Some(title) = &score.title {
        pages[0].draws.push(Draw::Text {
            x: width / 2.0,
            y: y + 1.0,
            size: 3.0,
            text: title.as_str().into(),
            anchor: "middle",
        });
        y += 4.0;
    }
    if let Some(composer) = &score.composer {
        pages[0].draws.push(Draw::Text {
            x: left + line_width,
            y: y + 0.5,
            size: 1.6,
            text: composer.as_str().into(),
            anchor: "end",
        });
        y += 2.0;
    }
    let mut first = true;
    let mut start = 0;
    for &end in &lines {
        let forced_page = start > 0 && measures[start - 1].brk == Some(true);
        if forced_page || (y + 4.0 + 3.0 > height - bottom && !first) {
            pages.push(Page {
                width,
                height,
                draws: Vec::new(),
            });
            y = top + 4.0;
        }
        let page = pages.last_mut().map(|p| &mut p.draws);
        if let Some(draws) = page {
            system(
                draws,
                &measures[start..end],
                font,
                shortest,
                left,
                y,
                line_width,
                first,
            );
        }
        first = false;
        y += SYSTEM_DISTANCE;
        start = end;
    }
    Layout {
        pages,
        systems: lines.len(),
        events,
    }
}

/// The music cut into measures, with accidentals decided and every measure's
/// width; and the shortest note, which sets every spring.
fn measures(music: &[Item], font: &Font) -> (Vec<Measure>, u32) {
    let mut out: Vec<Measure> = Vec::new();
    let (mut clef, mut key, mut time) = (Clef::Treble, 0i8, (4u8, 4u8));
    let new = |clef, key, time| Measure {
        cols: Vec::new(),
        clef,
        key,
        time,
        bar: "|".into(),
        brk: None,
        width: 0.0,
    };
    let mut m = new(clef, key, Some(time));
    let mut pos = 0u32;
    // Alterations in force in this measure, by diatonic step: the key's, then the notes'.
    let mut alters = [0i8; 128];
    let reset = |alters: &mut [i8; 128], key: i8| {
        for (s, a) in alters.iter_mut().enumerate() {
            *a = key_alter(key, (s % 7) as i8);
        }
    };
    reset(&mut alters, key);
    let measure_len = |t: (u8, u8)| WHOLE / t.1 as u32 * t.0 as u32;
    for item in music {
        match item {
            Item::Note {
                pitch,
                log,
                dots,
                len,
                forced,
                at,
            } => {
                let s = pitch.steps().clamp(0, 127) as usize;
                let acc = (*forced || alters[s] != pitch.alter).then_some(pitch.alter);
                alters[s] = pitch.alter;
                m.cols.push(Col::Note {
                    pitch: *pitch,
                    log: *log,
                    dots: *dots,
                    len: *len,
                    acc,
                    at: *at,
                });
                pos += len;
            }
            Item::Rest { log, dots, len, at } => {
                m.cols.push(Col::Rest {
                    log: *log,
                    dots: *dots,
                    len: *len,
                    at: *at,
                });
                pos += len;
            }
            Item::Skip { len } => {
                m.cols.push(Col::Skip { len: *len });
                pos += len;
            }
            Item::Clef(c) => {
                clef = *c;
                if m.cols.is_empty() {
                    m.clef = clef
                } else {
                    m.cols.push(Col::Clef(clef))
                }
            }
            Item::Key(k) => {
                key = *k;
                reset(&mut alters, key);
                if m.cols.is_empty() {
                    m.key = key
                } else {
                    m.cols.push(Col::Key(key))
                }
            }
            Item::Time(n, d) => {
                time = (*n, *d);
                if m.cols.is_empty() {
                    m.time = Some(time)
                } else {
                    m.cols.push(Col::Time(*n, *d))
                }
            }
            Item::Bar(kind) => match (m.cols.is_empty(), out.last_mut()) {
                (true, Some(last)) => last.bar = kind.clone(),
                _ => m.bar = kind.clone(),
            },
            Item::Break { page } => match (m.cols.is_empty(), out.last_mut()) {
                (true, Some(last)) => last.brk = Some(*page),
                _ => {
                    // A break inside a measure ends it there.
                    m.brk = Some(*page);
                    pos = measure_len(time);
                }
            },
        }
        // A bar line wherever the measure is full; a note that crosses it ends the measure anyway.
        if pos >= measure_len(time) {
            pos -= measure_len(time).min(pos);
            if m.brk.is_some() {
                pos = 0;
            }
            out.push(core::mem::replace(&mut m, new(clef, key, None)));
            reset(&mut alters, key);
        }
    }
    if !m.cols.is_empty() {
        out.push(m);
    }
    if let Some(last) = out.last_mut()
        && &*last.bar == "|"
    {
        last.bar = "|.".into();
    }
    let shortest = out
        .iter()
        .flat_map(|m| &m.cols)
        .filter_map(|c| match c {
            Col::Note { len, .. } | Col::Rest { len, .. } => Some(*len),
            _ => None,
        })
        .min()
        .unwrap_or(WHOLE / 4)
        .min(WHOLE / 8);
    for m in &mut out {
        let (fixed, spring) = m
            .cols
            .iter()
            .map(|c| col_width(c, font, shortest))
            .fold((0.0, 0.0), |a, w| (a.0 + w.0, a.1 + w.1));
        m.width = fixed + spring + 1.0;
    }
    (out, shortest)
}

/// A column's fixed width (what it covers) and its spring (the space a duration asks for).
fn col_width(c: &Col, font: &Font, shortest: u32) -> (f64, f64) {
    let spring = |len: u32| 1.6 + 1.25 * (len as f64 / shortest as f64).log2();
    match c {
        Col::Note {
            log,
            dots,
            len,
            acc,
            ..
        } => {
            let head = font.width(head_glyph(*log));
            let acc_w = acc.map_or(0.0, |a| font.width(acc_glyph(a)) + 0.25);
            let dots_w = if *dots > 0 {
                0.4 + 0.5 * *dots as f64
            } else {
                0.0
            };
            let flag = if *log >= 3 { 0.6 } else { 0.0 };
            (acc_w + head + dots_w + flag + 0.3, spring(*len))
        }
        Col::Rest { log, dots, len, .. } => {
            let dots_w = if *dots > 0 {
                0.4 + 0.5 * *dots as f64
            } else {
                0.0
            };
            (font.width(rest_glyph(*log)) + dots_w + 0.3, spring(*len))
        }
        Col::Skip { len } => (0.0, spring(*len)),
        Col::Clef(_) => (font.width("clefs.G") * 0.8 + 0.5, 0.0),
        Col::Key(k) => (key_width(*k) + 0.5, 0.0),
        Col::Time(..) => (font.width("four") + 0.8, 0.0),
    }
}

/// Where each line ends (exclusive measure index): the least squared stretch,
/// with forced breaks honoured.
fn break_lines(measures: &[Measure], font: &Font, line_width: f64) -> Vec<usize> {
    let n = measures.len();
    if n == 0 {
        return Vec::new();
    }
    let mut cost = vec![f64::INFINITY; n + 1];
    let mut from = vec![0usize; n + 1];
    cost[0] = 0.0;
    for j in 1..=n {
        let mut natural = 0.0;
        for i in (0..j).rev() {
            if i + 1 < j && measures[i].brk.is_some() {
                break;
            }
            natural += measures[i].width;
            let available = line_width - prefix(&measures[i], font, i == 0);
            if natural > available && i + 1 < j {
                break;
            }
            let stretch = available / natural - 1.0;
            let c = cost[i] + stretch * stretch * 10.0 + 1.0;
            if c < cost[j] {
                cost[j] = c;
                from[j] = i;
            }
        }
    }
    let mut ends = Vec::new();
    let mut j = n;
    while j > 0 {
        ends.push(j);
        j = from[j];
    }
    ends.reverse();
    ends
}

/// What a system draws before its first measure: clef, key, the time on the first.
fn prefix(m: &Measure, font: &Font, first: bool) -> f64 {
    let time = if first || m.time.is_some() {
        font.width("four") + 1.0
    } else {
        0.0
    };
    1.0 + font.width(clef_glyph(m.clef)) + 0.8 + key_width(m.key) + time
}

#[allow(clippy::too_many_arguments)]
fn system(
    draws: &mut Vec<Draw>,
    measures: &[Measure],
    font: &Font,
    shortest: u32,
    left: f64,
    top: f64,
    width: f64,
    first: bool,
) {
    let Some(head) = measures.first() else { return };
    for k in 0..5 {
        let y = top + k as f64;
        draws.push(Draw::Line {
            x1: left,
            y1: y,
            x2: left + width,
            y2: y,
            w: STAFF_LINE,
        });
    }
    let mut clef = head.clef;
    let mut x = left + 1.0;
    draws.push(Draw::Glyph {
        name: clef_glyph(clef),
        x,
        y: y_of(top, clef_position(clef)),
        link: None,
    });
    x += font.width(clef_glyph(clef)) + 0.8;
    x = key_signature(draws, head.key, clef, x, top);
    if first || head.time.is_some() {
        let (n, d) = head.time.unwrap_or((4, 4));
        time_signature(draws, font, n, d, x, top);
        x += font.width("four") + 1.0;
    }
    let natural: f64 = measures.iter().map(|m| m.width).sum();
    let springs: f64 = measures
        .iter()
        .flat_map(|m| &m.cols)
        .map(|c| col_width(c, font, shortest).1)
        .sum();
    // Justified: the springs take what the fixed widths leave.
    let extra = (left + width - x - natural).max(-springs * 0.5);
    let ratio = if springs > 0.0 {
        1.0 + extra / springs
    } else {
        1.0
    };
    for (i, m) in measures.iter().enumerate() {
        if i > 0 && m.time.is_some() {
            let (n, d) = m.time.unwrap_or((4, 4));
            time_signature(draws, font, n, d, x, top);
            x += font.width("four") + 1.0;
        }
        x += 0.5;
        for col in &m.cols {
            let (fixed, spring) = col_width(col, font, shortest);
            draw_col(draws, col, font, &mut clef, x, top);
            x += fixed + spring * ratio;
        }
        x += 0.5;
        let last = i + 1 == measures.len();
        let bx = if last { left + width } else { x };
        bar_line(draws, &m.bar, bx, top);
    }
}

fn draw_col(draws: &mut Vec<Draw>, col: &Col, font: &Font, clef: &mut Clef, x: f64, top: f64) {
    match col {
        Col::Note {
            pitch,
            log,
            dots,
            acc,
            at,
            ..
        } => {
            let p = pitch.steps() - clef.middle();
            let y = y_of(top, p);
            let mut hx = x;
            if let Some(a) = acc {
                draws.push(Draw::Glyph {
                    name: acc_glyph(*a),
                    x,
                    y,
                    link: None,
                });
                hx += font.width(acc_glyph(*a)) + 0.25;
            }
            let head = head_glyph(*log);
            let hw = font.width(head);
            draws.push(Draw::Glyph {
                name: head,
                x: hx,
                y,
                link: Some(*at),
            });
            for lp in (6..=p.abs()).step_by(2) {
                let ly = y_of(top, lp * p.signum());
                draws.push(Draw::Line {
                    x1: hx - 0.3,
                    y1: ly,
                    x2: hx + hw + 0.3,
                    y2: ly,
                    w: 0.16,
                });
            }
            if *log >= 1 {
                let up = p < 0;
                // A note far from the staff gets a stem to the middle line.
                let tip = if p.abs() > 7 {
                    y_of(top, 0)
                } else if up {
                    y - 3.5
                } else {
                    y + 3.5
                };
                let sx = if up {
                    hx + hw - STEM / 2.0
                } else {
                    hx + STEM / 2.0
                };
                draws.push(Draw::Line {
                    x1: sx,
                    y1: y,
                    x2: sx,
                    y2: tip,
                    w: STEM,
                });
                if *log >= 3 {
                    let name = flag_glyph(*log, up);
                    draws.push(Draw::Glyph {
                        name,
                        x: sx + STEM / 2.0,
                        y: tip,
                        link: None,
                    });
                }
            }
            dot_column(
                draws,
                *dots,
                hx + hw + 0.4,
                y_of(top, if p % 2 == 0 { p + 1 } else { p }),
            );
        }
        Col::Rest { log, dots, at, .. } => {
            let p = match log {
                0 => 2,
                _ => 0,
            };
            draws.push(Draw::Glyph {
                name: rest_glyph(*log),
                x,
                y: y_of(top, p),
                link: Some(*at),
            });
            dot_column(
                draws,
                *dots,
                x + font.width(rest_glyph(*log)) + 0.4,
                y_of(top, 1),
            );
        }
        Col::Skip { .. } => {}
        Col::Clef(c) => {
            *clef = *c;
            draws.push(Draw::Glyph {
                name: clef_glyph(*c),
                x,
                y: y_of(top, clef_position(*c)),
                link: None,
            });
        }
        Col::Key(k) => {
            key_signature(draws, *k, *clef, x, top);
        }
        Col::Time(n, d) => time_signature(draws, font, *n, *d, x, top),
    }
}

fn dot_column(draws: &mut Vec<Draw>, dots: u8, x: f64, y: f64) {
    for k in 0..dots {
        draws.push(Draw::Glyph {
            name: "dots.dot",
            x: x + 0.5 * k as f64,
            y,
            link: None,
        });
    }
}

fn bar_line(draws: &mut Vec<Draw>, kind: &str, x: f64, top: f64) {
    let thin = |draws: &mut Vec<Draw>, x| {
        draws.push(Draw::Line {
            x1: x,
            y1: top,
            x2: x,
            y2: top + 4.0,
            w: 0.16,
        })
    };
    match kind {
        "|." => {
            thin(draws, x - 0.9);
            draws.push(Draw::Line {
                x1: x - 0.25,
                y1: top,
                x2: x - 0.25,
                y2: top + 4.0,
                w: 0.5,
            });
        }
        "||" => {
            thin(draws, x - 0.6);
            thin(draws, x - 0.08);
        }
        "" => {}
        _ => thin(draws, x - 0.08),
    }
}

fn time_signature(draws: &mut Vec<Draw>, font: &Font, n: u8, d: u8, x: f64, top: f64) {
    for (value, baseline) in [(n, top + 2.0), (d, top + 4.0)] {
        let mut digits = [0u8; 3];
        let mut len = 0;
        let mut v = value;
        loop {
            digits[len] = v % 10;
            len += 1;
            v /= 10;
            if v == 0 {
                break;
            }
        }
        let mut dx = x;
        for &dgt in digits[..len].iter().rev() {
            let name = DIGITS[dgt as usize];
            draws.push(Draw::Glyph {
                name,
                x: dx,
                y: baseline,
                link: None,
            });
            dx += font.width(name);
        }
    }
}

fn key_signature(draws: &mut Vec<Draw>, key: i8, clef: Clef, mut x: f64, top: f64) -> f64 {
    // Treble positions; the other clefs move them down.
    const SHARPS: [i32; 7] = [4, 1, 5, 2, -1, 3, 0];
    const FLATS: [i32; 7] = [0, 3, -1, 2, -2, 1, -3];
    let shift = match clef {
        Clef::Treble => 0,
        Clef::Bass => -2,
        Clef::Alto => -1,
    };
    let (positions, name) = if key >= 0 {
        (&SHARPS, "accidentals.sharp")
    } else {
        (&FLATS, "accidentals.flat")
    };
    for &p in positions.iter().take(key.unsigned_abs().min(7) as usize) {
        draws.push(Draw::Glyph {
            name,
            x,
            y: y_of(top, p + shift),
            link: None,
        });
        x += 1.0;
    }
    if key != 0 { x + 0.6 } else { x }
}

fn key_width(key: i8) -> f64 {
    if key == 0 {
        0.0
    } else {
        key.unsigned_abs().min(7) as f64 + 0.6
    }
}

/// The alteration a key gives a diatonic step.
fn key_alter(key: i8, step: i8) -> i8 {
    // Steps in the order sharps come: f c g d a e b.
    const ORDER: [i8; 7] = [3, 0, 4, 1, 5, 2, 6];
    let k = key.unsigned_abs().min(7) as usize;
    let hit = if key >= 0 {
        ORDER[..k].contains(&step)
    } else {
        ORDER[7 - k..].contains(&step)
    };
    if !hit {
        0
    } else if key > 0 {
        1
    } else {
        -1
    }
}

/// Staff position (half spaces above the middle line) to y.
fn y_of(top: f64, p: i32) -> f64 {
    top + 2.0 - p as f64 / 2.0
}

fn clef_glyph(c: Clef) -> &'static str {
    match c {
        Clef::Treble => "clefs.G",
        Clef::Bass => "clefs.F",
        Clef::Alto => "clefs.C",
    }
}

fn clef_position(c: Clef) -> i32 {
    match c {
        Clef::Treble => -2,
        Clef::Bass => 2,
        Clef::Alto => 0,
    }
}

fn head_glyph(log: u8) -> &'static str {
    match log {
        0 => "noteheads.s0",
        1 => "noteheads.s1",
        _ => "noteheads.s2",
    }
}

fn rest_glyph(log: u8) -> &'static str {
    ["rests.0", "rests.1", "rests.2", "rests.3", "rests.4"][log.min(4) as usize]
}

fn flag_glyph(log: u8, up: bool) -> &'static str {
    match (log.min(5), up) {
        (3, true) => "flags.u3",
        (4, true) => "flags.u4",
        (_, true) => "flags.u5",
        (3, false) => "flags.d3",
        (4, false) => "flags.d4",
        _ => "flags.d5",
    }
}

fn acc_glyph(alter: i8) -> &'static str {
    match alter {
        a if a < 0 => "accidentals.flat",
        0 => "accidentals.natural",
        _ => "accidentals.sharp",
    }
}

const DIGITS: [&str; 10] = [
    "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
];

/// Every glyph the layout may draw: what `harness/build.sh` cuts into the pack.
pub const GLYPHS: &[&str] = &[
    "clefs.G",
    "clefs.F",
    "clefs.C",
    "noteheads.s0",
    "noteheads.s1",
    "noteheads.s2",
    "rests.0",
    "rests.1",
    "rests.2",
    "rests.3",
    "rests.4",
    "flags.u3",
    "flags.u4",
    "flags.u5",
    "flags.d3",
    "flags.d4",
    "flags.d5",
    "accidentals.sharp",
    "accidentals.flat",
    "accidentals.natural",
    "dots.dot",
    "zero",
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
];
