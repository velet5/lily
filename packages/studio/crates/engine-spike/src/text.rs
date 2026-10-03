//! Numbers and text without `core::fmt`: formatting machinery and float
//! printing are tens of KB of wasm that a writer of SVG numbers does not need
//! (09-spike.md §2).

pub fn push_int(out: &mut String, n: i64) {
    if n < 0 {
        out.push('-');
    }
    let mut digits = [0u8; 20];
    let mut i = digits.len();
    let mut v = n.unsigned_abs();
    loop {
        i -= 1;
        digits[i] = b'0' + (v % 10) as u8;
        v /= 10;
        if v == 0 {
            break;
        }
    }
    for &d in &digits[i..] {
        out.push(d as char);
    }
}

/// At most three decimals, without trailing zeros: what an SVG coordinate needs.
pub fn push_num(out: &mut String, v: f64) {
    let milli = (v * 1000.0).round() as i64;
    if milli < 0 {
        out.push('-');
    }
    let m = milli.unsigned_abs();
    push_int(out, (m / 1000) as i64);
    let mut frac = m % 1000;
    if frac != 0 {
        out.push('.');
        let mut div = 100;
        while frac != 0 {
            out.push((b'0' + (frac / div) as u8) as char);
            frac %= div;
            div /= 10;
        }
    }
}

pub fn push_escaped(out: &mut String, s: &str) {
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(c),
        }
    }
}

/// A JSON string literal.
pub fn push_json(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push(' '),
            c => out.push(c),
        }
    }
    out.push('"');
}

/// Where byte `at` of `src` is, in LilyPond's numbers: the 1-based line, the
/// 0-based CHAR in code points, and the 1-based COLUMN with tabs to the next
/// multiple of 8 (ARCHITECTURE.md §3.5).
pub fn location(src: &str, at: usize) -> (u32, u32, u32) {
    let before = &src[..at.min(src.len())];
    let line_start = before.rfind('\n').map_or(0, |i| i + 1);
    let line = before.bytes().filter(|&b| b == b'\n').count() as u32 + 1;
    let mut chars = 0;
    let mut column = 0;
    for c in before[line_start..].chars() {
        chars += 1;
        column = if c == '\t' {
            (column / 8 + 1) * 8
        } else {
            column + 1
        };
    }
    (line, chars, column + 1)
}
