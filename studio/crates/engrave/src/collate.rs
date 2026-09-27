//! A small stand-in for `Intl.Collator` with `numeric: true`, enough for file
//! names: runs of digits compare by value; spaces and punctuation sort before
//! digits, digits before letters, as in the CLDR root order; letters compare
//! case- and accent-insensitively first, then accents, then lower case before
//! upper case. It is not ICU: scripts other than Latin compare by code point.

use std::cmp::Ordering;

/// How far a comparison goes, as `Intl.Collator`'s `sensitivity`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sensitivity {
    /// Letters differ only by base letter: `a` = `á` = `A`.
    Base,
    /// Every difference counts, as the default `variant`.
    Variant,
}

// CLDR root order of the ASCII punctuation and symbols.
const PUNCTUATION: &str = "_-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$";

#[derive(Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Primary {
    Space,
    Punctuation(usize),
    Other(char),
    /// Digits without leading zeros: shorter is smaller, then lexically.
    Number(usize, String),
    Letter(char),
}

struct Element {
    primary: Primary,
    accent: u32,
    upper: bool,
}

fn elements(text: &str) -> Vec<Element> {
    let chars: Vec<char> = text.chars().collect();
    let mut result = Vec::new();
    let mut index = 0;
    while index < chars.len() {
        let char = chars[index];
        if char.is_ascii_digit() {
            let start = index;
            while index < chars.len() && chars[index].is_ascii_digit() {
                index += 1;
            }
            let digits: String = chars[start..index].iter().collect();
            let trimmed = digits.trim_start_matches('0');
            let value = if trimmed.is_empty() { "0" } else { trimmed };
            result.push(Element {
                primary: Primary::Number(value.len(), value.to_owned()),
                accent: 0,
                upper: false,
            });
            continue;
        }
        index += 1;
        let (base, accent) = fold(char);
        let primary = if char.is_whitespace() {
            Primary::Space
        } else if let Some(rank) = PUNCTUATION.find(char) {
            Primary::Punctuation(rank)
        } else if base.is_alphabetic() {
            Primary::Letter(base.to_lowercase().next().unwrap_or(base))
        } else {
            Primary::Other(char)
        };
        result.push(Element {
            primary,
            accent,
            upper: char.is_uppercase(),
        });
    }
    result
}

/// Compares `a` and `b` as `new Intl.Collator('en', { numeric: true, sensitivity })` would.
pub fn compare(a: &str, b: &str, sensitivity: Sensitivity) -> Ordering {
    let (a, b) = (elements(a), elements(b));
    let primary = a
        .iter()
        .map(|e| &e.primary)
        .cmp(b.iter().map(|e| &e.primary));
    if primary != Ordering::Equal || sensitivity == Sensitivity::Base {
        return primary;
    }
    a.iter()
        .map(|e| e.accent)
        .cmp(b.iter().map(|e| e.accent))
        .then_with(|| a.iter().map(|e| e.upper).cmp(b.iter().map(|e| e.upper)))
}

/// A Latin letter with a diacritic → its base letter and a rank for the diacritic.
fn fold(char: char) -> (char, u32) {
    const TABLE: &[(&str, char)] = &[
        ("àáâãäåāăą", 'a'),
        ("ÀÁÂÃÄÅĀĂĄ", 'A'),
        ("çćĉċč", 'c'),
        ("ÇĆĈĊČ", 'C'),
        ("ďđ", 'd'),
        ("ĎĐ", 'D'),
        ("èéêëēĕėęě", 'e'),
        ("ÈÉÊËĒĔĖĘĚ", 'E'),
        ("ĝğġģ", 'g'),
        ("ĜĞĠĢ", 'G'),
        ("ìíîïĩīĭįı", 'i'),
        ("ÌÍÎÏĨĪĬĮİ", 'I'),
        ("ñńņňŉ", 'n'),
        ("ÑŃŅŇ", 'N'),
        ("òóôõöøōŏő", 'o'),
        ("ÒÓÔÕÖØŌŎŐ", 'O'),
        ("ŕŗř", 'r'),
        ("ŔŖŘ", 'R'),
        ("śŝşšß", 's'),
        ("ŚŜŞŠ", 'S'),
        ("ţťŧ", 't'),
        ("ŢŤŦ", 'T'),
        ("ùúûüũūŭůűų", 'u'),
        ("ÙÚÛÜŨŪŬŮŰŲ", 'U'),
        ("ýÿ", 'y'),
        ("ÝŸ", 'Y'),
        ("źżž", 'z'),
        ("ŹŻŽ", 'Z'),
    ];
    for (letters, base) in TABLE {
        if let Some(position) = letters.chars().position(|c| c == char) {
            return (*base, position as u32 + 1);
        }
    }
    (char, 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use Ordering::*;

    #[test]
    fn numeric_and_case() {
        assert_eq!(compare("-9", "-10", Sensitivity::Variant), Less);
        assert_eq!(compare("", "-1", Sensitivity::Variant), Less);
        assert_eq!(compare("-2", "-alto-1", Sensitivity::Variant), Less);
        assert_eq!(
            compare("score 2.ly", "Score 10.ly", Sensitivity::Base),
            Less
        );
        assert_eq!(compare("a", "A", Sensitivity::Base), Equal);
        assert_eq!(compare("é", "e", Sensitivity::Base), Equal);
        assert_eq!(compare("a", "A", Sensitivity::Variant), Less);
        assert_eq!(compare("b", "Á", Sensitivity::Variant), Greater);
    }
}
