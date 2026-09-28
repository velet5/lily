//! String and path helpers that behave as the TypeScript this crate was ported
//! from did (D40): JavaScript's `\s` and `trim()`, lengths and cuts counted in
//! UTF-16 units as `.length` and `.slice()` count them, and Node's
//! `path.relative`. The renderer and chats.json saw those results before.

/// A character JavaScript's `\s` matches.
pub(crate) fn is_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// `text.trim()`.
pub(crate) fn trim(text: &str) -> &str {
    text.trim_matches(is_space)
}

/// `text.replace(/\s+/g, ' ').trim()`: one line, single spaces.
pub(crate) fn one_line(text: &str) -> String {
    let mut line = String::with_capacity(text.len());
    for word in text.split(is_space).filter(|word| !word.is_empty()) {
        if !line.is_empty() {
            line.push(' ');
        }
        line.push_str(word);
    }
    line
}

/// `text.length`.
pub(crate) fn len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `text.slice(0, units)`, except that a character outside the Basic
/// Multilingual Plane is never cut in half: it is left out whole.
pub(crate) fn prefix(text: &str, units: usize) -> &str {
    let mut count = 0;
    for (index, c) in text.char_indices() {
        count += c.len_utf16();
        if count > units {
            return &text[..index];
        }
    }
    text
}

/// `text.slice(-units)`, with the same care as `prefix`.
pub(crate) fn suffix(text: &str, units: usize) -> &str {
    let mut count = 0;
    for (index, c) in text.char_indices().rev() {
        count += c.len_utf16();
        if count > units {
            return &text[index + c.len_utf8()..];
        }
    }
    text
}

/// `line.length > max ? line.slice(0, max - 1) + '…' : line`.
pub(crate) fn ellipsis(line: String, max: usize) -> String {
    if len(&line) > max {
        format!("{}…", prefix(&line, max - 1))
    } else {
        line
    }
}

/// The segments of `path` made absolute against the working directory, with
/// `.` and `..` resolved, as `path.resolve` does on POSIX.
fn resolve(path: &str) -> Vec<String> {
    let mut segments: Vec<String> = Vec::new();
    let base = if path.starts_with('/') {
        String::new()
    } else {
        std::env::current_dir()
            .map(|dir| dir.to_string_lossy().into_owned())
            .unwrap_or_else(|_| "/".to_owned())
    };
    for segment in base.split('/').chain(path.split('/')) {
        match segment {
            "" | "." => {}
            ".." => {
                segments.pop();
            }
            _ => segments.push(segment.to_owned()),
        }
    }
    segments
}

/// Node's `path.relative(from, to)` on POSIX.
pub(crate) fn relative(from: &str, to: &str) -> String {
    if from == to {
        return String::new();
    }
    let from = resolve(from);
    let to = resolve(to);
    let common = from.iter().zip(&to).take_while(|(a, b)| a == b).count();
    let mut parts: Vec<&str> = vec![".."; from.len() - common];
    parts.extend(to[common..].iter().map(String::as_str));
    parts.join("/")
}

/// `file` is `folder` or inside it: `path.relative` neither climbs out nor is
/// absolute.
pub(crate) fn is_inside(folder: &str, file: &str) -> bool {
    let relative = relative(folder, file);
    !relative.starts_with("..") && !relative.starts_with('/')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strings_as_javascript_counts_them() {
        assert_eq!(one_line("  a \n\t b\u{FEFF} "), "a b");
        assert_eq!(trim("\u{A0} x \r\n"), "x");
        assert_eq!(len("a🎵"), 3);
        assert_eq!(prefix("a🎵b", 2), "a");
        assert_eq!(prefix("a🎵b", 3), "a🎵");
        assert_eq!(suffix("a🎵b", 2), "b");
        assert_eq!(suffix("abc", 5), "abc");
        assert_eq!(ellipsis("abcdef".into(), 4), "abc…");
        assert_eq!(ellipsis("abcd".into(), 4), "abcd");
    }

    #[test]
    fn relative_as_node() {
        assert_eq!(relative("/a/b", "/a/b/c/d.ly"), "c/d.ly");
        assert_eq!(relative("/a/b", "/a/x.ly"), "../x.ly");
        assert_eq!(relative("/a/b/", "/a/b"), "");
        assert_eq!(relative("/a/./b/../b", "/a/b/c"), "c");
        assert!(is_inside("/a", "/a/b"));
        assert!(!is_inside("/a", "/ab"));
    }
}
