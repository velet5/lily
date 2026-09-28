//! Where a diagnostic sits in a line of text (DECISIONS D16), from
//! packages/common/src/span.ts. lilypond counts columns in code points with tabs
//! advancing to the next multiple of 8 and `CHAR` in code points; the editor
//! counts UTF-16 units. The `*_byte` forms are the same conversions onto Rust's
//! UTF-8 offsets, which the snapshot uses internally.

const TAB_WIDTH: usize = 8;

fn advance(width: usize, char: char) -> usize {
    if char == '\t' {
        width + TAB_WIDTH - (width % TAB_WIDTH)
    } else {
        width + 1
    }
}

/// The width lilypond gives `text`: code points, tabs expanded.
pub fn display_width(text: &str) -> usize {
    text.chars().fold(0, advance)
}

/// A stderr column → a 0-based UTF-16 offset into the real line text, undoing
/// tab expansion and code-point counting. A column past the end of the line
/// yields the line length.
pub fn column_to_character(line_text: &str, column: usize) -> usize {
    let mut width = 0;
    let mut character = 0;
    for char in line_text.chars() {
        if width + 1 >= column {
            break;
        }
        width = advance(width, char);
        character += char.len_utf16();
    }
    character
}

/// `column_to_character`, as a byte offset into `line_text`.
pub fn column_to_byte(line_text: &str, column: usize) -> usize {
    let mut width = 0;
    for (index, char) in line_text.char_indices() {
        if width + 1 >= column {
            return index;
        }
        width = advance(width, char);
    }
    line_text.len()
}

/// A point-and-click `CHAR` → the editor's UTF-16 character: an astral character is two units.
pub fn char_to_character(line_text: &str, char: usize) -> usize {
    line_text.chars().take(char).map(char::len_utf16).sum()
}

/// The editor's UTF-16 character → `CHAR`.
pub fn character_to_char(line_text: &str, character: usize) -> usize {
    let mut units = 0;
    let mut count = 0;
    for char in line_text.chars() {
        if units >= character {
            break;
        }
        units += char.len_utf16();
        // Half an astral character is still counted, as Array.from counts a lone surrogate.
        count += 1;
    }
    count
}

/// The byte offset of code point `char` in `text`, or its length.
pub(crate) fn char_to_byte(text: &str, char: usize) -> usize {
    text.char_indices()
        .nth(char)
        .map_or(text.len(), |(index, _)| index)
}

/// Whitespace as JavaScript's `trim` sees it.
pub(crate) fn is_js_space(char: char) -> bool {
    char == '\u{feff}' || (char != '\u{85}' && char.is_whitespace())
}

/// `String.prototype.trim`.
pub(crate) fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_space)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Columns below are the ones lilypond printed for `\foo` in each line.
    #[test]
    fn tabs_advance_to_the_next_multiple_of_8() {
        assert_eq!(column_to_character("\tc4 \\foo d", 12), 4);
        assert_eq!(column_to_character("{ c4\t\\foo }", 9), 5);
        assert_eq!(column_to_character("{ c4 \t\t\\foo }", 17), 7);
    }

    #[test]
    fn columns_count_code_points_characters_are_utf16_units() {
        assert_eq!(column_to_character("  é ♪ \\bar \"x\" c4 \\foo", 19), 18);
        assert_eq!(column_to_character("{ 𝄞𝄞 \\foo }", 6), 7);
        assert_eq!(column_to_byte("{ 𝄞𝄞 \\foo }", 6), "{ 𝄞𝄞 ".len());
    }

    #[test]
    fn column_1_and_columns_past_the_end_of_the_line() {
        assert_eq!(column_to_character("\\foo", 1), 0);
        assert_eq!(column_to_character("\\foo", 40), 4);
        assert_eq!(column_to_character("", 3), 0);
    }

    #[test]
    fn char_and_the_editor_character() {
        // 𝄞 is one code point and two UTF-16 units; a tab is one of each.
        let text = "\t{ c'4^\"𝄞é\" d' }";
        let d = text.chars().position(|c| c == 'd').unwrap_or_default();
        let d_units: usize = text[..text.find('d').unwrap_or_default()]
            .encode_utf16()
            .count();
        assert_eq!(char_to_character(text, d), d_units);
        assert_eq!(d_units - d, 1);
        assert_eq!(char_to_character(text, 3), 3);
        let count = text.chars().count();
        for char in 0..=count {
            assert_eq!(character_to_char(text, char_to_character(text, char)), char);
        }
        assert_eq!(char_to_character(text, 500), text.encode_utf16().count());
        assert_eq!(character_to_char(text, 500), count);
    }
}
