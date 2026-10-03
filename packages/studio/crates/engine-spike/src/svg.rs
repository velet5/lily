//! A page as SVG, in chapter 06's form: each glyph's outline once in `<defs>`
//! and `<use>`d wherever it is drawn, every line of one thickness in one
//! path, and every note and rest linked as LilyPond links them (`<a
//! xlink:href="textedit://…"><g transform="translate(x, y)">`), the shape
//! chapter 00's comparator and the preview's point-and-click read.

use crate::font::{Font, UNIT};
use crate::layout::{Draw, Page};
use crate::text::{location, push_escaped, push_int, push_num};
use std::rc::Rc;

pub fn page(
    page: &Page,
    font: &Font,
    sources: &[(String, Rc<str>)],
    comment: Option<&str>,
) -> String {
    let mut out = String::with_capacity(4096 + page.draws.len() * 64);
    out.push_str("<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" version=\"1.2\" width=\"210.00mm\" height=\"297.00mm\" viewBox=\"0 0 ");
    push_num(&mut out, page.width);
    out.push(' ');
    push_num(&mut out, page.height);
    out.push_str("\">\n");
    if let Some(c) = comment {
        out.push_str("<!--");
        out.push_str(c);
        out.push_str("-->\n");
    }

    // The glyphs this page uses, each defined once.
    let mut used: Vec<&'static str> = Vec::new();
    for d in &page.draws {
        if let Draw::Glyph { name, .. } = d
            && !used.contains(name)
        {
            used.push(name);
        }
    }
    out.push_str("<defs>");
    for name in &used {
        if let Some(g) = font.get(name) {
            out.push_str("<path id=\"");
            out.push_str(name);
            out.push_str("\" transform=\"scale(");
            push_num(&mut out, UNIT);
            out.push(' ');
            push_num(&mut out, -UNIT);
            out.push_str(")\" d=\"");
            out.push_str(&g.path);
            out.push_str("\"/>");
        }
    }
    out.push_str("</defs>\n");

    // Lines, one path per thickness.
    let mut widths: Vec<(f64, String)> = Vec::new();
    for d in &page.draws {
        if let Draw::Line { x1, y1, x2, y2, w } = *d {
            let i = match widths.iter().position(|(ww, _)| *ww == w) {
                Some(i) => i,
                None => {
                    widths.push((w, String::new()));
                    widths.len() - 1
                }
            };
            let path = &mut widths[i].1;
            path.push('M');
            push_num(path, x1);
            path.push(' ');
            push_num(path, y1);
            if y1 == y2 {
                path.push('H');
                push_num(path, x2);
            } else if x1 == x2 {
                path.push('V');
                push_num(path, y2);
            } else {
                path.push('L');
                push_num(path, x2);
                path.push(' ');
                push_num(path, y2);
            }
        }
    }
    for (w, path) in &widths {
        out.push_str("<path fill=\"none\" stroke=\"currentColor\" stroke-width=\"");
        push_num(&mut out, *w);
        out.push_str("\" d=\"");
        out.push_str(path);
        out.push_str("\"/>\n");
    }

    for d in &page.draws {
        match d {
            Draw::Glyph { name, x, y, link } => {
                if let Some(origin) = link {
                    let (path, src) = &sources[origin.file as usize];
                    let (line, ch, column) = location(src, origin.at as usize);
                    out.push_str("<a xlink:href=\"textedit://");
                    push_escaped(&mut out, path);
                    for n in [line, ch, column] {
                        out.push(':');
                        push_int(&mut out, n as i64);
                    }
                    out.push_str("\">");
                }
                out.push_str("<g transform=\"translate(");
                push_num(&mut out, *x);
                out.push_str(", ");
                push_num(&mut out, *y);
                out.push_str(")\"><use xlink:href=\"#");
                out.push_str(name);
                out.push_str("\" fill=\"currentColor\"/></g>");
                if link.is_some() {
                    out.push_str("</a>");
                }
                out.push('\n');
            }
            Draw::Text {
                x,
                y,
                size,
                text,
                anchor,
            } => {
                out.push_str("<text font-family=\"serif\" font-size=\"");
                push_num(&mut out, *size);
                out.push_str("\" text-anchor=\"");
                out.push_str(anchor);
                out.push_str("\" x=\"");
                push_num(&mut out, *x);
                out.push_str("\" y=\"");
                push_num(&mut out, *y);
                out.push_str("\" fill=\"currentColor\">");
                push_escaped(&mut out, text);
                out.push_str("</text>\n");
            }
            Draw::Line { .. } => {}
        }
    }
    out.push_str("</svg>\n");
    out
}
