//! The music font as a data module (chapter 08 §2.2): a pack the host puts
//! into the engine with `lily_put`, one glyph per line, `name<TAB>advance<TAB>path`,
//! in Emmentaler's units of 1/1000 em. `harness/build.sh` cuts it from
//! LilyPond's `emmentaler-20.svg`, so no glyph outline is kept in this crate.

use std::collections::BTreeMap;

/// Font units to staff spaces: Emmentaler's em is four staff spaces.
pub const UNIT: f64 = 0.004;

pub struct Glyph {
    pub advance: f64,
    pub path: Box<str>,
}

#[derive(Default)]
pub struct Font {
    glyphs: BTreeMap<Box<str>, Glyph>,
}

impl Font {
    pub fn parse(pack: &[u8]) -> Font {
        let text = String::from_utf8_lossy(pack);
        let mut glyphs = BTreeMap::new();
        for line in text.lines() {
            let mut parts = line.splitn(3, '\t');
            let (Some(name), Some(advance), Some(path)) =
                (parts.next(), parts.next(), parts.next())
            else {
                continue;
            };
            let units = advance
                .bytes()
                .filter(u8::is_ascii_digit)
                .fold(0u32, |n, c| n * 10 + (c - b'0') as u32);
            glyphs.insert(
                name.into(),
                Glyph {
                    advance: units as f64 * UNIT,
                    path: path.into(),
                },
            );
        }
        Font { glyphs }
    }

    pub fn is_empty(&self) -> bool {
        self.glyphs.is_empty()
    }

    pub fn get(&self, name: &str) -> Option<&Glyph> {
        self.glyphs.get(name)
    }

    /// Advance width in staff spaces; a missing glyph takes one.
    pub fn width(&self, name: &str) -> f64 {
        self.get(name).map_or(1.0, |g| g.advance)
    }
}
