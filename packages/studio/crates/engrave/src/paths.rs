//! Lexical path operations with Node's `path` semantics (POSIX), so that paths
//! are spelled exactly as the TypeScript spelled them: `resolve` and
//! `normalize` never touch the file system, unlike `std::fs::canonicalize`.

use std::path::{Path, PathBuf};

/// `path.normalize`: `.` and `..` resolved, repeated separators collapsed, a
/// trailing separator kept.
pub fn normalize(path: impl AsRef<Path>) -> PathBuf {
    let text = path.as_ref().to_string_lossy();
    if text.is_empty() {
        return PathBuf::from(".");
    }
    let absolute = text.starts_with('/');
    let trailing = text.ends_with('/');
    let mut parts: Vec<&str> = Vec::new();
    for part in text.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.last().is_some_and(|last| *last != "..") {
                    parts.pop();
                } else if !absolute {
                    parts.push("..");
                }
            }
            other => parts.push(other),
        }
    }
    let mut joined = parts.join("/");
    if joined.is_empty() && !absolute {
        joined.push('.');
    }
    if trailing && !joined.is_empty() {
        joined.push('/');
    }
    PathBuf::from(if absolute {
        format!("/{joined}")
    } else {
        joined
    })
}

/// `path.resolve(base, path)`: absolute and normalized, without a trailing separator.
pub fn resolve_from(base: impl AsRef<Path>, path: impl AsRef<Path>) -> PathBuf {
    let path = path.as_ref();
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        base.as_ref().join(path)
    };
    let joined = if joined.is_absolute() {
        joined
    } else {
        current_dir().join(joined)
    };
    strip_trailing(normalize(joined))
}

/// `path.resolve(path)`, against the process's working directory.
pub fn resolve(path: impl AsRef<Path>) -> PathBuf {
    resolve_from(current_dir(), path)
}

/// `path.relative(from, to)` of two paths, resolved first.
pub fn relative(from: impl AsRef<Path>, to: impl AsRef<Path>) -> String {
    let from = resolve(from);
    let to = resolve(to);
    let from_text = from.to_string_lossy();
    let to_text = to.to_string_lossy();
    let a: Vec<&str> = from_text.split('/').filter(|p| !p.is_empty()).collect();
    let b: Vec<&str> = to_text.split('/').filter(|p| !p.is_empty()).collect();
    let common = a.iter().zip(&b).take_while(|(x, y)| x == y).count();
    let mut parts: Vec<&str> = vec![".."; a.len() - common];
    parts.extend(&b[common..]);
    parts.join("/")
}

/// `path.dirname`.
pub fn dirname(path: impl AsRef<Path>) -> PathBuf {
    let path = path.as_ref();
    match path.parent() {
        Some(parent) if parent.as_os_str().is_empty() => PathBuf::from("."),
        Some(parent) => parent.to_path_buf(),
        None if path.is_absolute() => PathBuf::from("/"),
        None => PathBuf::from("."),
    }
}

/// `path.basename`.
pub fn basename(path: impl AsRef<Path>) -> String {
    path.as_ref()
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// `path.basename(file, path.extname(file))`.
pub fn stem(path: impl AsRef<Path>) -> String {
    let name = basename(path);
    match name.rfind('.') {
        Some(dot) if dot > 0 => name[..dot].to_owned(),
        _ => name,
    }
}

/// `path.extname`, lower-cased.
pub fn extension_lower(path: impl AsRef<Path>) -> String {
    let name = basename(path);
    match name.rfind('.') {
        Some(dot) if dot > 0 => name[dot..].to_lowercase(),
        _ => String::new(),
    }
}

fn strip_trailing(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    if text.len() > 1 && text.ends_with('/') {
        PathBuf::from(text.trim_end_matches('/'))
    } else {
        path
    }
}

fn current_dir() -> PathBuf {
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn like_node() {
        assert_eq!(normalize("/a/b/../c/./d/"), PathBuf::from("/a/c/d/"));
        assert_eq!(normalize("/.."), PathBuf::from("/"));
        assert_eq!(normalize("a/../.."), PathBuf::from(".."));
        assert_eq!(
            resolve_from("/scores", "parts/../x.ily"),
            PathBuf::from("/scores/x.ily")
        );
        assert_eq!(
            resolve_from("/scores", "/abs dir/"),
            PathBuf::from("/abs dir")
        );
        assert_eq!(relative("/music", "/music/a/b.ly"), "a/b.ly");
        assert_eq!(relative("/music", "/music"), "");
        assert_eq!(relative("/music", "/"), "..");
        assert_eq!(stem("/a/etude-2.ly"), "etude-2");
        assert_eq!(stem("/a/.ly"), ".ly");
        assert_eq!(extension_lower("/a/B.LY"), ".ly");
        assert_eq!(dirname("/a"), PathBuf::from("/"));
    }
}
