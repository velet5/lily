# 06 — Small SVG output, with PDF and fonts loaded on demand

Chapter 06 of the investigation into an engine of our own (chapter 00 sets
the budgets and the test set, chapter 01 maps LilyPond's source, chapters
02–05 design the parser, the Scheme interpreter, the music model and the
layout). It describes how LilyPond writes its output (§1), counts the music
glyphs the 30 scores of chapter 00 draw (§2), measures what LilyPond's SVG
pages are made of and what drawing each glyph once, and a writer of our own,
save in bytes and in the browser's time (§3), chooses the music font (§4)
and how fonts reach the engine (§5), and designs the SVG writer (§6) and a
PDF module that downloads only when the user exports (§7). It records no
decision; D56 (step 11) will.

Everything refers to LilyPond at tag `v2.26.0` (commit
`3596756be0fac1f81066a99d2054329212172b2d`). **[measured]** marks what was
taken on 2026-10-03 on the M1 Max of chapter 00 with `GNU LilyPond 2.26.0
(running Guile 3.0)` of Homebrew, `rsvg-convert` and ImageMagick for pixel
comparisons, headless Chrome 154 for the browser's time, fontTools 4.41 for
fonts, brotli 1.2 at `-q 11`, and rustc 1.97 for the PDF probes; the recipes
are in Appendix A. KB is 1,000 bytes. Projections onto the phones use chapter
00's factors (× 1/0.45 for the Android reference's CPU; the browser's own
work on the page is native code, so the factor of 1.5 for wasm does not
apply to it).

## 1. How LilyPond writes its output

- **The SVG backend** is Scheme: `scm/framework-svg.scm` (129 lines) writes
  one file per page, and `scm/output-svg.scm` (664) turns each stencil
  expression into markup. A page is written by `ly:outputter-dump-stencil`,
  which calls, for every primitive of the page's stencil, the procedure that
  `stencil-dispatch-alist` names for it (`paper-outputter.cc` makes a hash
  table of the alist when the outputter is created). Every page starts with
  `set-unit-length`.
- **A music glyph** (`named-glyph`, and `glyph-string` for a run of glyphs
  such as `\dynamic "sff"`) goes through `cache-font`, which takes the
  glyph's `<glyph>` element out of the font's SVG version (`fonts/svg/`,
  2.6 MB for the eight optical sizes and the braces) and writes its whole
  outline as a `<path transform="scale(s, -s)" d="…"
  fill="currentColor"/>`, at every use. The position comes from the
  enclosing `<g transform="translate(x, y)">` of `settranslation`.
- **A link** (`grob-cause`) is `<a style="color:inherit;"
  xlink:href="textedit:///absolute/path.ly:LINE:CHAR:COLUMN">` around the
  grob's group; D19's point-and-click and chapter 00's comparator read this
  shape.
- **Lines, boxes, beams and bows** are `<line>`, `<rect>` (stems, bar lines,
  staff lines, `round-filled-box`), `<polygon>` (beams) and `<path>` with
  numbers printed with four decimals (`~4f`).
- **Text** is `<text font-family="…" font-size="…">` with the Pango font
  description taken apart, so the browser draws it with its own fonts (D1
  accepts the difference); LilyPond measured it with Pango and fontconfig.
- **PDF** is written by the `ps` backend (`framework-ps.scm`,
  `output-ps.scm`) and turned into PDF by Ghostscript (the PDFs of §7 say
  `Producer (GPL Ghostscript 10.08.0)`); `-dbackend=cairo` writes it with
  Cairo (`cairo.cc`) instead. Either way every font is embedded as a subset.
- **Fonts.** Emmentaler, the music font, comes in eight optical sizes
  (`emmentaler-11` … `-26`, 664 glyphs each) and `emmentaler-brace` (576
  braces of increasing height). Each OTF carries LilyPond's own tables:
  `LILC`, a zlib-compressed Scheme alist per glyph (`bbox`, and for note
  heads `attachment`, `attachment-down` and `ledger-shortening-range`; 61 KB
  as text), and `LILY`, global values (`staff_space`, `blot_diameter`, …).
  Text uses C059, Nimbus Sans and Nimbus Mono PS (URW's base 35 fonts,
  four styles each) unless a score names another font, which fontconfig
  then finds on the system (T20: Times New Roman and Hiragino Mincho).

## 2. What the test set draws

**[measured]**: `census.scm` wraps `cache-font` and records every music
glyph drawn by the 30 scores, compiled as chapter 00 §3 compiles them.
*Draws* counts glyphs drawn, *kinds* distinct (font, glyph, size).

- **3,851 glyph draws**, 3,496 of them single glyphs and 355 inside glyph
  strings (dynamics, time-signature digits, figured bass).
- **95 distinct glyph names**: 82 from the eight optical sizes and 13
  braces. A score draws a median of 10 kinds and at most 29 (T28, T29).
  Nine names are drawn by 10 or more scores: `clefs.G` (28 scores),
  `noteheads.s2` (27), `timesig.C44` (22), `dots.dot` (14),
  `accidentals.sharp` (13), `accidentals.natural`, `clefs.F`,
  `noteheads.s1` (11 each) and `rests.3` (10); 27 names are drawn by three
  or more.
- **Optical sizes are not rare.** `emmentaler-20`, the default staff size,
  is used by 24 scores, `-14` by 8 (grace notes and small staves),
  `-brace` by 8, `-11` by 4, `-13` by 3, `-16` by 2, `-18`, `-23` and `-26`
  by one each. 18 scores need only `-20` and the braces. Of the draws, 1,669
  are in `-20`, 1,162 in `-11` (T29's staff size 10), 843 in `-14`.
- **The braces drawn** are `brace97` to `brace300` of 576.

## 3. Page bytes, and what the browser does with them

### 3.1 What a LilyPond page is made of

**[measured]**, the 33 pages of the 30 scores, 2,698 KB in all (217 KB
gzipped, 150 KB brotli):

| Part | Share of the bytes |
| --- | --- |
| Glyph `<path>`s, each with its whole outline | 36.1 % |
| Links: `<a style="color:inherit;" xlink:href="textedit://…">` and `</a>` | 22.6 % (the `textedit:` URIs alone 17.3 %) |
| Groups: `<g transform="translate(…)">` and `</g>` | 16.7 % |
| `<rect>` | 10.6 % |
| `<polygon>` | 4.7 % |
| `<line>` | 4.3 % |
| Other `<path>`s (bows, brackets) | 2.7 % |
| `<text>` | 2.0 % |
| The rest (header, style) | 0.4 % |

The link URIs carry the score's absolute path: the run directory here is
long, which is why T29's page is 688 KB here and 680 KB in chapter 00. The
music glyphs are a third of the bytes but only 29 kinds at most.

### 3.2 Each glyph once per page

`packages/common/runtime/glyph-cache.scm` now has a second mode, off unless
the code that loads it defines `lily-glyph-reuse?` true first. It rewrites
what `cache-font` returns: the first use of a glyph on a page writes its
outline once, in a `<defs>`, as `<path id="lily-g-emmentaler-20-noteheads.s2-0.0040"
transform="scale(0.0040, -0.0040)" d="…" fill="currentColor"/>`, and every
use becomes `<use xlink:href="#…"/>`, keeping a glyph string's
`transform="translate(…)"`. The id names the font file, the glyph and its
scale, so the same glyph on two pages of one document is the same element.
The page's table of glyphs it has defined is cleared by a wrapper of
`set-unit-length`. The preview never sets the flag: its pages stay
LilyPond's byte for byte, as D25 requires and both apps' tests check.

**[measured]** on the 30 scores, with that mode:

- **Correct**: with each `<use>` replaced by its definition's `<path>`,
  every page equals LilyPond's byte for byte, except T16's one link to
  `<included string>`, which LilyPond resolves against the output directory
  (different for the two runs). Rendered with `rsvg-convert` at twice the
  page size, the six pages of T02, T12, T24 and T29 are identical to
  LilyPond's, pixel for pixel.
- **Smaller uncompressed, not compressed**: 2,126 KB, 79 % of LilyPond's
  (T29 69 %, T05 70 %; the shortest scores grow by up to 5 %, since a glyph
  drawn once costs a `<defs>` and a `<use>` more), but 91 % gzipped and
  102 % with brotli: both compressors already find the repeated outlines.
  The definitions are 7.6 % of the bytes.

### 3.3 What a writer of our own adds

`compact.py` rewrites the glyph-reuse pages step by step, each step keeping
the drawing, to estimate what the engine's writer (§6) writes. **[measured]**
on all 33 pages, as a share of LilyPond's bytes:

| Step | What changes | Raw | gzip | brotli |
| --- | --- | --- | --- | --- |
| LilyPond | | 2,698 KB | 217.1 KB | 149.7 KB |
| glyph reuse | §3.2 | 79 % | 91 % | 102 % |
| + fold | an unlinked object's `translate` group is folded into its own `x`/`y` (`<use>`, `<rect>`, `<line>`); a linked one keeps its group | 72 % | 92 % | 103 % |
| + numbers | trailing zeros and leading `0` dropped (`12.0000` → `12`, `-0.5000` → `-.5`) | 70 % | 91 % | 103 % |
| + links | `style="color:inherit;"` once, in the page's `<style>` | 67 % | 90 % | 103 % |
| + inherit | `fill="currentColor"` and round caps and joins once, on a group around the page | 61 % | 89 % | 102 % |
| + paths | links name the file by its path in the engine's virtual file tree (`textedit:///score.ly:…`) instead of a long absolute path | **47 %** | 86 % | 99 % |

Elements: 21,824 → 17,895 (−18 %). Per score, LilyPond's bytes → the last
row's, and the elements:

| ID | Pages | LilyPond KB | Glyph reuse KB | Compact KB | Compact / LilyPond | Elements | Draws | Kinds | Fonts |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| T01 | 1 | 7 | 7 | 5 | 74 % | 58 → 53 | 8 | 4 | 20 |
| T02 | 2 | 44 | 37 | 25 | 58 % | 389 → 327 | 52 | 8 | 20 |
| T03 | 1 | 11 | 11 | 8 | 67 % | 119 → 90 | 10 | 6 | 20 |
| T04 | 1 | 60 | 51 | 30 | 50 % | 518 → 445 | 77 | 9 | 14, 20 |
| T05 | 1 | 86 | 61 | 35 | 41 % | 640 → 557 | 132 | 6 | 20 |
| T06 | 1 | 38 | 32 | 21 | 55 % | 251 → 239 | 45 | 17 | 11, 16, 20 |
| T07 | 1 | 76 | 57 | 33 | 44 % | 579 → 510 | 110 | 13 | 20 |
| T08 | 1 | 39 | 35 | 20 | 51 % | 338 → 287 | 36 | 4 | 20 |
| T09 | 1 | 25 | 23 | 15 | 60 % | 196 → 185 | 34 | 10 | 13, 14, 20 |
| T10 | 1 | 20 | 19 | 13 | 63 % | 176 → 150 | 34 | 10 | 13, 20 |
| T11 | 1 | 24 | 22 | 13 | 55 % | 220 → 173 | 28 | 6 | 20, brace |
| T12 | 1 | 133 | 113 | 65 | 48 % | 1,092 → 908 | 177 | 16 | 14, 20 |
| T13 | 1 | 16 | 16 | 13 | 80 % | 168 → 165 | 12 | 10 | 20, brace |
| T14 | 1 | 6 | 6 | 5 | 76 % | 56 → 47 | 6 | 4 | 20 |
| T15 | 1 | 7 | 7 | 5 | 74 % | 56 → 58 | 8 | 5 | 20 |
| T16 | 1 | 6 | 6 | 4 | 72 % | 52 → 45 | 6 | 3 | 20 |
| T17 | 2 | 41 | 35 | 21 | 51 % | 380 → 280 | 45 | 3 | 20 |
| T18 | 1 | 25 | 19 | 12 | 46 % | 186 → 153 | 32 | 5 | 20 |
| T19 | 1 | 9 | 8 | 7 | 75 % | 66 → 64 | 14 | 7 | 20 |
| T20 | 1 | 25 | 23 | 15 | 58 % | 224 → 207 | 11 | 3 | 20 |
| T21 | 1 | 16 | 14 | 11 | 69 % | 133 → 100 | 25 | 10 | 14, 26, brace |
| T22 | 1 | 75 | 66 | 42 | 56 % | 623 → 584 | 75 | 22 | 11, 13, 14, 20 |
| T23 | 1 | 76 | 60 | 42 | 55 % | 798 → 556 | 123 | 16 | 16, 23 |
| T24 | 2 | 472 | 385 | 218 | 46 % | 4,006 → 3,211 | 670 | 21 | 20, brace |
| T25 | 1 | 89 | 66 | 45 | 51 % | 824 → 525 | 180 | 17 | 11, 14, brace |
| T26 | 1 | 97 | 78 | 49 | 51 % | 686 → 596 | 102 | 20 | 20, brace |
| T27 | 1 | 83 | 79 | 53 | 64 % | 632 → 611 | 45 | 8 | 20, brace |
| T28 | 1 | 167 | 119 | 72 | 43 % | 1,233 → 1,010 | 278 | 29 | 14, 18 |
| T29 | 1 | 688 | 477 | 269 | 39 % | 5,110 → 4,125 | 1,120 | 29 | 11, brace |
| T30 | 1 | 238 | 190 | 109 | 46 % | 2,015 → 1,634 | 356 | 17 | 14 |

What it says:

- **B10's Goal (half of LilyPond's bytes) is reached only by all the steps
  together**, and only on average: 47 % over the corpus, 39–64 % for the
  13 scores whose pages exceed 50 KB, up to 80 % for the smallest, whose
  pages are mostly the fixed header and links. B10's Must (no bigger than LilyPond's) holds for every
  score.
- **Compression makes the steps almost free and almost useless**: brotli
  sizes stay within ±3 % of LilyPond's at every step. What the steps save is
  what is never compressed: the string the worker hands to the page, the
  text the browser parses, and the files a user exports.
- **The drawing is kept.** The pages of T02, T12, T24 and T29 after the
  last step differ from LilyPond's in at most 256 of 3.57 million pixels,
  each by one grey level of 255: folding a translation into coordinates
  rounds anti-aliasing differently. Linked elements keep chapter 00's
  `<a xlink:href><g transform="translate(x, y)">` shape, so the comparator
  and the preview's point-and-click read them as before.

### 3.4 The browser's time

What the preview does with a page on the main thread (`preview.js`'s
`toPage` without the sanitizer, which walks the same elements): parse the
text, import it, insert it and lay it out. **[measured]** in headless Chrome
154 on the M1 Max, the first page of T02, T24 and T29, median of 12 runs, in
ms; *inline* is the compact page with every `<use>` replaced by its glyph's
`<path>` (identical pixels to the compact page):

| Page | Form | Characters | Elements | Parse | Insert and lay out | Total |
| --- | --- | --- | --- | --- | --- | --- |
| T02 p. 1 | LilyPond | 25,772 | 217 | 0.4 | 0.5 | 0.8 |
| | glyph reuse | 20,872 | 233 | 0.4 | 0.5 | 0.9 |
| | compact | 14,289 | 181 | 0.3 | 0.4 | 0.7 |
| | compact, glyphs inline | 18,773 | 165 | 0.3 | 0.4 | 0.7 |
| T24 p. 1 | LilyPond | 331,359 | 2,817 | 4.5 | 4.5 | 9.2 |
| | glyph reuse | 270,903 | 2,855 | 4.3 | 5.3 | 9.6 |
| | compact | 151,673 | 2,253 | 3.2 | 4.7 | 7.9 |
| | compact, glyphs inline | 202,607 | 2,215 | 3.1 | 3.3 | 6.4 |
| T29 | LilyPond | 687,526 | 5,110 | 8.2 | 8.5 | 16.7 |
| | glyph reuse | 477,098 | 5,168 | 7.4 | 10.4 | 17.7 |
| | compact | 268,731 | 4,125 | 5.6 | 9.0 | 14.6 |
| | compact, glyphs inline | 456,339 | 4,067 | 6.5 | 6.6 | 13.1 |

What it says:

- **The cost follows the elements, not the bytes.** A `<use>` is a small
  element to parse but an expensive one to insert: each gets a shadow tree
  with a copy of its glyph. Glyph reuse makes T29's page 31 % smaller and
  6 % slower; the compact page with `<use>` is 13 % faster than LilyPond's,
  with glyphs inline 22 %.
- **Projected onto the Android reference** (× 1/0.45), the whole T29 page
  takes 37 ms as LilyPond writes it, 32 ms compact and 29 ms compact with
  glyphs inline, before painting. B7 allows 50 ms for the longest task: the
  whole of T29's one page fits, but not with room for painting and the
  preview's own work (sanitizing, indexing links). An edit should therefore
  replace less than a page (§6.4).

## 4. The music font: Emmentaler, not Bravura

**[measured]**, Emmentaler-20 of LilyPond 2.26 against Bravura 1.482
(`steinbergmedia/bravura`, `redist/`). An *outline subset* is the font cut
by `pyftsubset` to the given glyphs with only `CFF `, `cmap`, `hmtx`,
`hhea`, `head` and `maxp`, without hinting; the corpus's glyphs in Bravura
are the SMuFL glyphs that correspond to the 82 Emmentaler names of §2 (78,
since SMuFL has one scalable brace and some names share a glyph; the mapping
is in Appendix A):

| | Emmentaler-20 | Bravura |
| --- | --- | --- |
| Glyphs | 664 | 3,715 |
| The OTF, raw / brotli | 98 KB / 51 KB | 889 KB / 324 KB (WOFF2 323 KB) |
| Outline subset, all glyphs | 88 KB / 35 KB | 786 KB / 260 KB |
| Outline subset, the corpus's glyphs | 11.6 KB / 8.0 KB (82) | 20.5 KB / 11.8 KB (78) |
| Outline subset, the 27 glyphs of 3 or more scores | 3.8 KB / 2.9 KB | 9.6 KB / 5.0 KB |
| Metrics the layout needs | `LILC` and `LILY` in the font: 6.2 KB compressed per size | `bravura_metadata.json` (SMuFL), 1,257 KB / 67 KB |
| Optical sizes | 8, plus 576 braces | 1, and a scalable brace |
| License | SIL OFL 1.1, or GPL with the font exception | SIL OFL 1.1 |

Emmentaler, for three reasons:

- **Only Emmentaler can pass the comparator.** C4 compares positions with
  LilyPond's, and LilyPond's layout reads Emmentaler's metrics everywhere:
  note-head widths and stem attachments (`LILC`'s `attachment`), ledger
  shortening, flag and dot sizes, `blot_diameter`, the optical size chosen
  for a staff size. Bravura's glyphs have other widths and anchors (its
  `engravingDefaults` differ too: staff lines 0.13 staff spaces against
  Emmentaler's 0.1), so every column would move; C4 could not tell a
  layout bug from a font difference.
- **It is 1.5–1.7 times smaller with brotli for the same music**, 7 times
  for the whole font, and its metrics are 6 KB per size against SMuFL's 67 KB of JSON
  (brotli) for one.
- **Nothing is lost for later.** SMuFL fonts can be an optional module after
  the core passes: a map from LilyPond's glyph names to SMuFL's, metrics
  read from the font's metadata, and the scores accepting that positions
  move. LilyPond does not support SMuFL fonts itself, so no test score
  needs one.

## 5. Fonts in the engine

### 5.1 A font pack per optical size

The engine does not read OTF at run time. A build step turns each
Emmentaler file into a **font pack**: the glyph names in LilyPond's order,
per glyph its advance, bounding box and `LILC` attachments, the `LILY`
values, and the outline as integer font units in a compact path encoding
(the CFF charstrings flattened: they are what FreeType gave LilyPond, and
what the SVG writer prints as `d`). Measured as outline subsets (§4), a
whole pack is about 35 KB with brotli, B2's 60 KB per music font with room;
the build step writes our own encoding, whose size step W1 (§9) measures
against these numbers.

**Glyph skylines are computed at first use, not shipped.** Chapter 05 §5.7
planned to compute each glyph's skyline pair at font build and ship it with
the metrics. **[measured]** with `ly:skylines-for-stencil` on all 663 drawn
glyphs of Emmentaler-20: 35,110 points, 53 per glyph (`clefs.GG` has 168).
Stored as LilyPond computes them (f64) that is 562 KB, 70 KB with brotli;
as f32 49 KB; quantized to 1/1000 of a staff space (no longer LilyPond's
values) 31 KB, per optical size. Computing them instead from the pack's
outline with `stencil-integral.cc`'s procedure, once per glyph and size
in a session, costs nothing to download and gives the same values; a score
draws at most 29 kinds, so it computes at most 29 skyline pairs, which is
cheap next to the per-grob cost chapter 05 measured (LilyPond recomputes
the skyline for every grob, which is where its 37–59 % went). The procedure
is needed anyway for every other stencil (§5.7 of chapter 05).

### 5.2 Which packs are in the core

| Pack | Where | Size (brotli, from §4's subsets) | Why |
| --- | --- | --- | --- |
| Emmentaler-20 | core | ≈ 35 KB | 24 of 30 scores; the default staff size |
| Emmentaler-11, -13, -14, -16, -18, -23, -26 | on demand, one file each | ≈ 35 KB each | 1–8 scores each; `-14` is the first to prefetch (grace notes, cue notes, `\small` staves) |
| Braces | on demand, four files of 144 braces | 5.2–6.6 KB each (20.7 KB for all 576) | 8 scores, which used braces 97–300 |
| Text metrics, C059 Roman, Bold, Italic | core | ≈ 11 KB each | titles, lyrics, instrument names, markup |
| Text metrics, the other URW styles | on demand | ≈ 11 KB each | |

The core's fonts are about 35 + 33 ≈ 70 KB, under 5 % of B1's 1.5 MB.

**Loading on demand without waiting in the middle of a layout.** A pack is
needed as soon as layout asks for a glyph's extent, so the engine must have
it before layout starts. The sizes a score needs are known early: the
staff size is set by Scheme during parsing (`set-global-staff-size`,
`layout-set-staff-size`) and by `\layout` blocks, font-size changes by
`\override`/`\tweak` of `font-size` during translation, and grace notes by
the music. The engine therefore asks the host for a pack when parsing or
translation first meets its size, and layout waits only if it has not
arrived; with the packs cached by the service worker (chapter 08) the wait
happens once per device. A pack that cannot be fetched (offline, first use)
is a diagnostic on the score, not a crash.

### 5.3 Text

- **In SVG**, text stays what LilyPond writes, `<text>` with the font family
  named, drawn by the browser (D1).
- **For layout** the engine needs the text's widths as LilyPond measured
  them, so it ships **metric packs**: per style the advance of every
  character (C059 Roman: 854 characters, 5.1 KB, 2.3 KB with brotli) and the
  pair kerning HarfBuzz applies (3,821 pairs, 22.9 KB, 8.5 KB with brotli):
  about 11 KB a style. Shaping is a port of what Pango does for these fonts:
  `cmap`, advances, `kern` pairs, and whichever ligatures Pango applies to
  these fonts, which W6 checks against LilyPond's output.
- **Characters no pack covers** (T20's Japanese, any script beyond Latin,
  Greek and Cyrillic) are measured in the worker with an `OffscreenCanvas`
  `measureText` (Chrome; Safari since 16.4), in the font the SVG will name.
  That is what the browser will draw, not what LilyPond measured with
  fontconfig's choice, so C4 may differ near such text; T20 is the test.
- **Licenses.** The URW fonts are under the AGPL with an exception for
  embedding them in PostScript and PDF files; the engine's PDF module does
  exactly that (§7), and the metric packs hold measurements, not outlines.
  Whether the AGPL needs more than shipping the fonts' source with the PDF
  module's download is for step 11 to settle; Emmentaler and Bravura (OFL)
  raise no such question.

## 6. The SVG writer

### 6.1 What it must do

| # | Requirement | Why |
| --- | --- | --- |
| W-a | Draw what LilyPond draws: the same stencil primitives with the same coordinates, `currentColor` paint, `<text>` with LilyPond's font attributes | C4; D1's theme colours; the preview's CSS |
| W-b | Keep every linked element as `<a xlink:href="textedit://FILE:LINE:CHAR:COLUMN">` whose first child is `<g transform="translate(x, y)">` | chapter 00 §5.2's comparator; D19 |
| W-c | Pages no bigger than LilyPond's, and on average half (B10) | §3.3 |
| W-d | Keep the page's main-thread cost within B7 | §3.4 |
| W-e | Write only what an edit changed (chapter 05's Y9) | B6's 30 ms for SVG |
| W-f | Pass the preview's sanitizer unchanged | D17 |

### 6.2 The page

- **A group around the page** sets `fill="currentColor"
  stroke-linejoin="round" stroke-linecap="round"`, and the page's `<style>`
  holds `tspan { white-space: pre; }` and `a { color: inherit }`. Elements
  write those attributes only where they differ (`fill="none"`, other
  caps).
- **Numbers** are printed as LilyPond computes them with four decimals,
  then without trailing zeros and the leading `0`: the same value LilyPond
  writes, in fewer characters.
- **Unlinked objects** carry their position in their own attributes (`x`
  and `y` of a `<use>` or `<rect>`, the ends of a `<line>`); linked ones
  keep their `translate` group (W-b).
- **Links** name the file by its path in the engine's file tree, which the
  host maps to the real file as it does today (D19, D25's snapshot
  mapping). The comparator drops directories, so it is unaffected.
- **Glyphs**, in two forms of the same writer:
  - *file form*, for exported SVG and for the comparator: each glyph defined
    once per page in a `<defs>` and drawn with `<use>`, exactly as §3.2's
    prototype writes it, with the same ids. Every page stands alone.
  - *preview form*, for the pages the worker sends to the preview: every
    glyph drawn in place as a `<path>`, because shadow trees make `<use>`
    slower to insert (§3.4) and the bytes are never sent over a network.

  §3.3's compact pages are what the file form writes; with glyphs inline
  they are the preview form (T29: 269 KB and 456 KB against LilyPond's
  688 KB).

### 6.3 Writing only what changed

Chapter 05 hands over positioned stencils per grob with stable ids (its
Y9), page by page, the visible page first (its §7.2). The writer keeps, per
grob, the markup it wrote and the digest of the stencil and position it
wrote it from; a grob whose digest is unchanged reuses its markup, so an
edit writes the markup of the grobs chapter 05 laid out again (T29 E1: 88
of 3,175) and concatenates the rest. The markup is kept per cell (chapter
05 §6.1: one staff's line in one system), in the order LilyPond writes
grobs, so that unchanged cells are one copy each. Its memory is about the
page's bytes once more (T29: 0.5 MB in the preview form), which B4 can
afford for the pages on screen; pages far from the visible one keep only
their stencils and are written again when shown.

### 6.4 Sending less than a page

Today a changed page is sent whole and the preview re-parses it (D25 reuses
unchanged pages by hash). For a score that is one page (27 of the 30), every
edit is that page, and §3.4 shows T29's page alone costs 29 ms of B7's 50 on
the Android reference. The engine's pages therefore wrap each cell in a
`<g data-lily-cell="DIGEST">` (the sanitizer keeps `data-` attributes), and
the protocol to the preview gains a message that replaces cells by digest
within a page it already shows; a page whose cells all changed, or a new
page, is still sent whole. A pitch edit (chapter 05 §3: one cell) then costs
the preview about that cell's share of the page. The message and its use in
`preview.js` (and Lily Studio's `preview.ts`) belong to the roadmap's
preview milestone, where they can be measured on the phones of chapter 09;
nothing in `preview.js` needs to change for the engine's pages before that,
since both forms of §6.2 are plain SVG it already accepts.

### 6.5 Cost

Writing is formatting numbers and copying strings: the compact T29 page is
4,125 elements. Its time is budgeted at chapter 00's 30 ms for an S edit
on the Android reference, and with §6.3 an edit formats only the changed
grobs; step 10 times it.

## 7. PDF as a module loaded on export

### 7.1 What LilyPond's PDFs are

**[measured]**, `lilypond --pdf` (the `ps` backend through Ghostscript):

| Score | PDF | Fonts embedded (all subsets) | Their streams |
| --- | --- | --- | --- |
| T02 | 55.6 KB | C059 Roman and Bold, Emmentaler-20 | 35.3 KB |
| T20 | 127.2 KB | Times New Roman and Hiragino Mincho (from the system), Emmentaler-20 | 19.9 KB |
| T24 | 255.5 KB | C059 Roman and Bold, Nimbus Sans Regular and Bold, Emmentaler-20, the braces | 53.6 KB |
| T29 | 360.6 KB | C059 Roman, Bold, Italic and Bold Italic, Emmentaler-11, the braces | 68.0 KB |

Fonts are a large part of a short score's PDF, and LilyPond embeds only the
glyphs it used. Embedding whole text fonts would add about 70 KB per style
(a C059 style deflated), more than doubling T02's file.

### 7.2 Three probes

How big a PDF writer is in wasm. **[measured]**: three crates (Appendix A),
each with an `extern "C"` entry that takes a display list and returns the
PDF, built for `wasm32-unknown-unknown` with `opt-level = "z"`, LTO, one
codegen unit, `panic = "abort"` and `strip`, without `wasm-opt` (chapter 08's
settings will shrink them further):

| Probe | What it links | Raw | gzip | brotli |
| --- | --- | --- | --- | --- |
| `pdfmod` | `pdf-writer` 0.15, `miniz_oxide` 0.9, `ttf-parser` 0.25, `subsetter` 0.2.6: parses fonts, subsets them, writes text with ToUnicode maps | 1,078 KB | 337 KB | 260 KB |
| `pdfttf` | the same without `subsetter`: whole fonts embedded | 208 KB | 95 KB | 83 KB |
| `pdfmin` | `pdf-writer` and `miniz_oxide` only: the core hands over glyph outlines and the glyph ids, advances and characters of the text; whole text fonts embedded | 132 KB | 59 KB | 52 KB |

`subsetter` 0.2 alone costs 177 KB with brotli: it brings `skrifa`,
`read-fonts`, `write-fonts` and `kurbo` for variable fonts, which LilyPond's
fonts are not.

### 7.3 Design

- **A separate wasm module**, `lily-pdf`, fetched the first time the user
  exports and kept in the cache (chapter 08); instantiated in the engine's
  worker with its own memory, and dropped after the export, so its memory
  leaves with it (B4).
- **Its input** is the core's display list for every page: the stencils
  §6.3 already holds (positioned glyphs, boxes, lines, polygons, Béziers,
  text runs already shaped by the core into glyph ids and advances), the
  outlines of the music glyphs used, and the `\header` fields for the PDF's
  Info dictionary (LilyPond writes them through `pdfmark`).
- **Music glyphs as form XObjects**: each outline once, drawn by `Do` at
  every use, the PDF's counterpart of `<use>`, so music needs no font
  program and no subsetter.
- **Text as CID fonts with ToUnicode maps**, so a PDF's lyrics and titles
  can be selected and searched as LilyPond's can. The text fonts' files are
  fetched with the module, only for the styles the score uses (C059 Roman
  63 KB with brotli, each style about the same), and subset by **our own
  CFF subsetter**: these fonts are static CFF fonts, so a subsetter keeps
  the used charstrings and the charset, and copies the subroutines whole,
  a few hundred lines of Rust, estimated at 20–40 KB of wasm with brotli. The
  module would then be about 75–90 KB with brotli, against `subsetter`'s
  260 KB; that crate is the fallback, inside B2's 500 KB.
- **Scripts beyond the URW fonts** (T20): the module fetches a font that
  covers them, per script and in Unicode-range pieces as web fonts are
  served (Noto, OFL), only for the characters the score uses. Until then
  such text is the open gap of the PDF module, reported as a warning.
- **No point-and-click**, as in D5's exports; deflate on every stream.
- **Checked** by page count and by rasterizing the engine's PDF against its
  own SVG pages at the same scale (pdf.js, which Lily Studio already
  bundles, in the harness of chapter 09), plus text extraction of lyrics and
  titles. LilyPond's PDFs are not the reference for pixels: the positions
  are compared on the SVG side (C4), and the two writers share them.

## 8. Budgets

Proposed for step 11 to confirm; times on chapter 00's Android reference.

| What | Must | Goal | Now |
| --- | --- | --- | --- |
| B10: SVG bytes of a page, file form, against LilyPond's | ≤ 100 % per page | ≤ 50 % over the corpus | 39–80 %, 47 % over the corpus (§3.3) |
| Main thread: one page parsed, inserted and laid out (part of B7) | 50 ms | 20 ms | T29 29 ms (preview form, projected); with cells (§6.4) about a cell's share |
| SVG writing per edit (B6's split) | 30 ms | 10 ms | not measured; step 10 |
| Music font pack, brotli (B2) | 60 KB | 40 KB | ≈ 35 KB per optical size as an outline subset (§4) |
| Brace pack, brotli, each of four | 15 KB | 8 KB | 5.2–6.6 KB |
| Fonts in the core, brotli (share of B1) | 120 KB | 80 KB | ≈ 70 KB (§5.2) |
| Text metric pack, brotli, per style | 20 KB | 12 KB | ≈ 11 KB |
| PDF module, brotli (B2) | 500 KB | 100 KB | 52 KB without subsetting, 260 KB with `subsetter` (§7.2) |
| Exported PDF against LilyPond's for the same score | ≤ 150 % | ≤ 110 % | not measured |
| Writer's memory, kept markup of the pages on screen (part of B4) | 4 MB | 1 MB | T29: about 0.5 MB in the preview form |

## 9. The ordered steps

| Step | What | Checked by |
| --- | --- | --- |
| W1 | Font build: Emmentaler's eight sizes and the braces into packs (names, metrics, `LILC`, `LILY`, outlines in our encoding); the text metric packs | pack sizes against §8; every glyph's extent equal to LilyPond's `ly:stencil-extent` of `ly:font-get-glyph` |
| W2 | Glyph outlines to skylines with `stencil-integral.cc`'s procedure, once per glyph and size | the 663 skylines of `skylines.ly` (Appendix A), point for point |
| W3 | The SVG writer, file form: the primitives of `output-svg.scm`, links, the page group, numbers, folding, `<defs>` and `<use>` with §3.2's ids | chapter 00's comparator (C4, links); pixels against LilyPond's pages as in §3.3; §3.3's per-score sizes |
| W4 | Preview form and markup kept per grob and cell; cells as `data-lily-cell` groups | an edit's pages equal a from-scratch write; chapter 00's edits |
| W5 | On-demand packs: requests from parsing and translation, the host's fetch, the diagnostic when a pack is missing | T06, T09, T22, T29 (sizes other than 20); offline |
| W6 | Text: shaping with the metric packs, `OffscreenCanvas` for the rest | C4 near lyrics and titles (T02, T04, T20, T21) |
| W7 | The PDF module: display list, XObject glyphs, CID text fonts, own CFF subsetter, Info dictionary | page count, rasterized against the engine's SVG, text extraction; module size against §8 |
| W8 | The cell-replacing message in the preview (with the roadmap's preview milestone) | main-thread time per edit on the phones (chapter 09) |

W1–W3 come first: W3 makes chapter 00's comparator usable on the engine's
pages, which every layout step of chapter 05 needs. W7 can be built at any
time after W3, since it only consumes the display list.

## 10. What later chapters take from here

| Chapter | Takes |
| --- | --- |
| 07 MIDI | nothing from the output; the MIDI file is its own writer |
| 08 build | the font packs as separate cached files (§5.2), the PDF module as an on-demand wasm (§7.3), the probes' build settings as the baseline for `wasm-opt` |
| 09 phone timings | step 10's crate writes one staff as SVG in the preview form: time the writer, and the page's parse and insert on the phones against §3.4's projection |
| 11 roadmap, D56 | Emmentaler as the font (§4); skylines computed at first use, replacing chapter 05 §5.7's table (§5.1); the two forms of the writer; steps W1–W8; the budgets of §8; the cell message of §6.4; the URW license question of §5.3 |

## Appendix A: recipes

The LilyPond checkout and the test scores are those of chapter 00;
`corpus.tsv` lists `ID path` for the 30 scores. Scripts run from one
directory, `$S`.

**Compiles** (§2, §3): each score compiled plain, with glyph reuse, and
with the census, as chapter 00 §3 compiles it:

```sh
#!/bin/bash
# run.sh: each score of corpus.tsv compiled plain, with glyph reuse, and with the census.
S=$(cd $(dirname $0) && pwd); G=<repo>/packages/common/runtime/glyph-cache.scm
while IFS=$'\t' read id file; do
  base=$(basename "$file" .ly); mkdir -p $S/out/$id/plain $S/out/$id/reuse $S/out/$id/census
  cd "$(dirname "$file")"
  LANGUAGE=en lilypond --loglevel=WARNING --svg -dpoint-and-click -o $S/out/$id/plain/$base "$file" 2> $S/out/$id/plain.err
  LANGUAGE=en lilypond --loglevel=WARNING --svg -dpoint-and-click \
    -e "(begin (define lily-glyph-reuse? #t) (load \"$G\"))" -o $S/out/$id/reuse/$base "$file" 2> $S/out/$id/reuse.err
  CENSUS_OUT=$S/out/$id/census.tsv LANGUAGE=en lilypond --loglevel=WARNING --svg -dpoint-and-click \
    -e "(begin (load \"$G\") (load \"$S/census.scm\"))" -o $S/out/$id/census/$base "$file" 2> $S/out/$id/census.err
done < $S/corpus.tsv
```

`census.scm`:

```scheme
;; Chapter 06's census: every music glyph the SVG backend draws, one line each:
;; font file, size, glyph name, and whether it came as a string or a glyph-string list.
(let* ((m (resolve-module '(lily output-svg)))
       (inner (module-ref m 'cache-font))
       (port (open-file (getenv "CENSUS_OUT") "w")))
  (module-set! m 'cache-font
    (lambda (font size glyph)
      (let ((name (if (pair? glyph) (car (last-pair glyph)) glyph)))
        (display (string-append (basename font) "\t" (number->string size) "\t"
                                (if (string? name) name "?") "\t"
                                (if (pair? glyph) "list" "string") "\n") port)
        (force-output port))
      (inner font size glyph))))
```

**Sizes and the round trip** (§3.1, §3.2): `analyze.py` reads `out/` and
`census.tsv`, puts each `<use>` back as its definition's `<path>`, compares
with the plain page, splits the plain pages' bytes by the categories of
§3.1 and counts the census:

```python
# analyze.py: chapter 06's page sizes and glyph census over out/<id>/{plain,reuse,census.tsv}.
import os, re, gzip, subprocess, collections, json
S = os.path.dirname(os.path.abspath(__file__))
ids = [l.split('\t')[0] for l in open(f'{S}/corpus.tsv')]
def br(b): return len(subprocess.run(['brotli', '-q', '11', '-c'], input=b, capture_output=True).stdout)
def gz(b): return len(gzip.compress(b, 9))
def pages(d):
    fs = [f for f in os.listdir(d) if f.endswith('.svg')]
    return sorted(fs, key=lambda f: int(m.group(1)) if (m := re.search(r'-(\d+)\.svg$', f)) else 0)
DEF = re.compile(r'<defs><path id="([^"]+)" transform="scale\(([^)]*)\)" d="([^"]*)" fill="currentColor"/></defs>\n')
USE = re.compile(r'<use xlink:href="#([^"]+)"(?: transform="([^"]*)")?/>\n')
def inline(text):
    defs = {m.group(1): (m.group(2), m.group(3)) for m in DEF.finditer(text)}
    def path(m):
        scale, d = defs[m.group(1)]
        t = (m.group(2) + ' ' if m.group(2) else '') + f'scale({scale})'
        return f'<path transform="{t}" d="{d}" fill="currentColor"/>\n'
    return USE.sub(path, DEF.sub('', text)), len(defs)
CATS = [('glyph paths', re.compile(r'<path transform="[^"]*scale\([^"]*" d="[^"]*" fill="currentColor"/>\n')),
        ('links', re.compile(r'<a style="color:inherit;" xlink:href="[^"]*">\n|</a>\n')),
        ('groups', re.compile(r'<g transform="translate\([^)]*\)">\n|</g>\n|<g[^>]*>\n')),
        ('lines', re.compile(r'<line [^>]*/>\n')), ('boxes', re.compile(r'<rect [^>]*/>\n')),
        ('other paths', re.compile(r'<path [^>]*/>\n')), ('polygons', re.compile(r'<polygon [^>]*/>\n')),
        ('text', re.compile(r'<text [^>]*>.*?</text>\n', re.S))]
rows = []; cats = collections.Counter(); names = collections.Counter(); fonts = collections.Counter()
for id in ids:
    P, R = f'{S}/out/{id}/plain', f'{S}/out/{id}/reuse'
    pp, rp = pages(P), pages(R)
    plain = b''.join(open(f'{P}/{f}', 'rb').read() for f in pp)
    reuse = b''.join(open(f'{R}/{f}', 'rb').read() for f in rp)
    same = all(inline(open(f'{R}/{b}').read())[0] == open(f'{P}/{a}').read() for a, b in zip(pp, rp))
    text = plain.decode()
    for name, rx in CATS:
        cats[name] += sum(len(m.group(0)) for m in rx.finditer(text)); text = rx.sub('', text)
    cats['rest'] += len(text)
    draws = [l.rstrip('\n').split('\t') for l in open(f'{S}/out/{id}/census.tsv')]
    for n in set(n for f, s, n, k in draws): names[n] += 1
    for f in set(f for f, s, n, k in draws): fonts[f] += 1
    rows.append(dict(id=id, pages=len(pp), raw=len(plain), gz=gz(plain), br=br(plain), raw2=len(reuse), gz2=gz(reuse),
                     br2=br(reuse), same=same, draws=len(draws), kinds=len(set((f, s, n) for f, s, n, k in draws))))
json.dump(dict(rows=rows, cats=cats, names=names, fonts=fonts), open(f'{S}/analysis.json', 'w'))
```

**The writer's steps** (§3.3): `compact.py` applies the steps of the table
to each glyph-reuse page, writes the result to `out/<id>/compact` and
prints each step's sizes:

```python
# compact.py: what chapter 06's SVG writer would write, simulated on the glyph-reuse pages.
import os, re, gzip, subprocess
from decimal import Decimal
S = os.path.dirname(os.path.abspath(__file__))
ids = [l.split('\t')[0] for l in open(f'{S}/corpus.tsv')]
NUM = re.compile(r'-?\d+\.\d+')
def num(s):
    s = s.rstrip('0').rstrip('.') if '.' in s else s
    if s in ('-0', ''): s = '0'
    return s.replace('0.', '.', 1) if s.startswith('0.') else s.replace('-0.', '-.', 1)
def numbers(text):  # only inside attribute values, never in text content
    return re.sub(r'(\s[\w:-]+=")([^"]*)(")', lambda m: m.group(1) + NUM.sub(lambda n: num(n.group(0)), m.group(2)) + m.group(3), text)
def inherit(text):
    for a in [' fill="currentColor"', ' stroke-linejoin="round"', ' stroke-linecap="round"']: text = text.replace(a, '')
    head, sep, body = text.partition(']]>\n</style>\n')
    body = body.replace('</svg>', '</g>\n</svg>', 1)
    return head + 'a{color:inherit}\n' + sep + '<g fill="currentColor" stroke-linejoin="round" stroke-linecap="round">\n' + body
def links(text): return text.replace('<a style="color:inherit;" ', '<a ')
def add(a, b): return str(Decimal(a) + Decimal(b))
FOLD = re.compile(r'(?<!">\n)<g transform="translate\((-?[\d.]+), (-?[\d.]+)\)">\n(<(use|rect|line)\b([^>]*)/>)\n</g>\n')
def fold(text):  # not after an <a ...>: a linked object keeps its group
    def one(m):
        x, y, el, tag, attrs = m.groups()
        if tag == 'use':
            return m.group(0) if ' transform=' in attrs or ' x=' in attrs else f'<use{attrs} x="{x}" y="{y}"/>\n'
        if tag == 'rect':
            attrs = re.sub(r' x="([^"]*)"', lambda a: f' x="{add(a.group(1), x)}"', attrs)
            attrs = re.sub(r' y="([^"]*)"', lambda a: f' y="{add(a.group(1), y)}"', attrs)
            return f'<rect{attrs}/>\n'
        attrs = re.sub(r' (x[12])="([^"]*)"', lambda a: f' {a.group(1)}="{add(a.group(2), x)}"', attrs)
        attrs = re.sub(r' (y[12])="([^"]*)"', lambda a: f' {a.group(1)}="{add(a.group(2), y)}"', attrs)
        return f'<line{attrs}/>\n'
    return FOLD.sub(one, text)
def paths(text): return re.sub(r'textedit:///[^"]*/', 'textedit:///', text)
def br(b): return len(subprocess.run(['brotli', '-q', '11', '-c'], input=b, capture_output=True).stdout)
steps = [('reuse', lambda t: t), ('+fold', fold), ('+numbers', numbers), ('+links', links), ('+inherit', inherit), ('+paths', paths)]
total = {k: [0, 0, 0] for k, _ in steps}
for id in ids:
    R, C = f'{S}/out/{id}/reuse', f'{S}/out/{id}/compact'; os.makedirs(C, exist_ok=True)
    per = {k: b'' for k, _ in steps}
    for f in sorted(f for f in os.listdir(R) if f.endswith('.svg')):
        t = open(f'{R}/{f}').read()
        for k, fn in steps: t = fn(t); per[k] += t.encode()
        open(f'{C}/{f}', 'w').write(t)
    for k, _ in steps: total[k] = [a + b for a, b in zip(total[k], [len(per[k]), len(gzip.compress(per[k], 9)), br(per[k])])]
print(total)
```

**Pixels** (§3.2, §3.3): `rsvg-convert -z 2 -b white page.svg -o page.png`
for each form, then `magick compare -metric AE` (pixels that differ) and
`-metric PAE` (the largest difference) against LilyPond's page.

**The browser's time** (§3.4): `make.py` writes the first page of T02, T24
and T29 in the four forms of the table into `bench.html` (the `<use>`s of
the compact page put back as `<path>`s for *inline*, as `analyze.py` does,
with a `<use>`'s `x`/`y` becoming a `translate`), whose script is:

```js
// What the preview does with a page on the main thread (preview.js toPage, without sanitize):
// parse, import, insert, lay out. Median and p90 of 12 runs, in ms.
const quiet = (t) => t.replace(/(<[A-Za-z][^<>]*?)\sstyle="[^"]*"/g, '$1')
for (const [key, text] of Object.entries(pages)) {
  const parse = [], insert = [], times = []
  for (let i = 0; i < 12; i++) {
    const host = document.getElementById('pages'); host.replaceChildren()
    const t0 = performance.now()
    const svg = new DOMParser().parseFromString(quiet(text), 'image/svg+xml').documentElement
    const t1 = performance.now()
    const node = document.importNode(svg, true)
    node.removeAttribute('width'); node.removeAttribute('height'); node.style.width = '800px'
    host.append(node)
    node.getBoundingClientRect(); document.body.offsetHeight
    const t2 = performance.now()
    parse.push(t1 - t0); insert.push(t2 - t1); times.push(t2 - t0)
  }
  // … the medians are written into <pre id="out">
}
```

run as `"Google Chrome" --headless=new --disable-gpu --user-data-dir=<new dir>
--dump-dom file://$S/bench/bench.html`, reading the result from the dumped
DOM.

**Skylines** (§5.1): `skylines.ly`, compiled with `SKY_OUT=e20.tsv lilypond
-dno-print-pages skylines.ly`; writing `(list name down up)` instead of the
counts gives the points themselves, which were packed as f64, f32 and i16
and compressed:

```lilypond
\version "2.26.0"
%% Chapter 06: every glyph of the music font at the default staff size, with the
%% number of points of its vertical skyline pair (horizon axis X) as LilyPond
%% computes them from the outline.
#(define-markup-command (census layout props) ()
   (let* ((font (ly:paper-get-font layout (cons '((font-encoding . fetaMusic)) props)))
          (port (open-file (getenv "SKY_OUT") "w")))
     (for-each
       (lambda (name)
         (let* ((stil (ly:font-get-glyph font name)))
           (unless (ly:stencil-empty? stil)
             (let* ((skyp (ly:skylines-for-stencil stil X))
                    (down (ly:skyline->points (car skyp) X))
                    (up (ly:skyline->points (cdr skyp) X)))
               (display (string-append name "\t" (number->string (length down)) "\t"
                                       (number->string (length up)) "\n") port)))))
       (ly:otf-glyph-list font))
     (close-port port)
     empty-stencil))
\markup \census
```

**Fonts** (§4, §5): outline subsets with

```sh
pyftsubset <font>.otf --glyph-names --glyphs-file=names.txt --no-hinting --desubroutinize \
  --drop-tables+=GPOS,GSUB,GDEF,FFTM,name,post,OS/2 --output-file=sub.otf
brotli -q 11 -c sub.otf | wc -c
```

with `--unicodes=` instead of `--glyphs-file=` for Bravura, from
`redist/otf/Bravura.otf` and the codepoints of SMuFL's `glyphnames.json`
for these names (Emmentaler → SMuFL): `clefs.G` gClef, `noteheads.s2`
noteheadBlack, `timesig.C44` timeSigCommon, `dots.dot` augmentationDot,
`accidentals.sharp` accidentalSharp, `accidentals.natural`
accidentalNatural, `clefs.F` fClef, `noteheads.s1` noteheadHalf, `rests.3`
rest8th, `accidentals.flat` accidentalFlat, `flags.d3` flag8thDown,
`flags.u3` flag8thUp, `noteheads.s0` noteheadWhole, `rests.2` restQuarter,
`p` dynamicPiano, `brackettips.down` bracketBottom, `brackettips.up`
bracketTop, `f` dynamicForte, `flags.d4` flag16thDown, `flags.u4`
flag16thUp, `four` timeSig4, `eight` timeSig8, `flags.ugrace`
graceNoteSlashStemUp, `rests.0` restWhole, `rests.1` restHalf, `rests.4`
rest16th, `scripts.ufermata` fermataAbove, `clefs.F_change` fClefChange,
`clefs.G_change` gClefChange, `fattened.fixedwidth.seven.alt` figbass7,
`fattened.fixedwidth.six` figbass6, `fattened.one` figbass1,
`fattened.three` figbass3, `fattened.two` figbass2, `m` dynamicMezzo,
`nine` timeSig9, `noteheads.s0harmonic` noteheadDiamondWhole, `s`
dynamicSforzando, `scripts.sforzato` articAccentAbove, `six` timeSig6,
`three` timeSig3, `accidentals.flat.figbass` figbassFlat,
`accidentals.flatflat` accidentalDoubleFlat, `accidentals.mirroredflat`
accidentalFlatTurned, `accidentals.natural.figbass` figbassNatural,
`accidentals.sharp.figbass` figbassSharp, `clefs.C` cClef,
`clefs.percussion` unpitchedPercussionClef1, `clefs.vaticana.do`
chantCclef, `fattened.fixedwidth.five` figbass5,
`fattened.fixedwidth.four.alt` figbass4, `fattened.fixedwidth.nine`
figbass9, `figbass.sixstroked` figbass6Raised, `five` timeSig5, `flags.d5`
flag32ndDown, `flags.d6` flag64thDown, `flags.dgrace`
graceNoteSlashStemDown, `flags.u5` flag32ndUp, `noteheads.s2cross`
noteheadXBlack, `noteheads.s2do` noteShapeTriangleUpBlack,
`noteheads.s2la` noteShapeSquareBlack, `noteheads.s2mi`
noteShapeDiamondBlack, `noteheads.s2re` noteShapeMoonBlack,
`noteheads.s2triangle` noteheadTriangleUpBlack, `noteheads.s2xcircle`
noteheadCircleX, `one` timeSig1, `pedal.*` keyboardPedalUp, `pedal.Ped`
keyboardPedalPed, `plus` timeSigPlus, `scripts.arpeggio`
wiggleArpeggiatoUp, `scripts.dfermata` fermataBelow, `scripts.open`
brassMuteOpen, `scripts.rcomma` breathMarkComma, `scripts.staccato`
articStaccatoAbove, `scripts.stopped` brassMuteClosed, `scripts.trill`
ornamentTrill, `z` dynamicZ, every brace → brace. `endash` and `period`
are text glyphs and were left out on both sides of the corpus row.

Text metric packs: with fontTools, the best `cmap` of the font packed as
(codepoint u32, advance u16) per character, and the format 1 pair
adjustments of its `GPOS` pair-positioning lookups as (first glyph u16,
second glyph u16, x advance i16), each compressed with brotli.

**PDF probes** (§7.2): three library crates with `crate-type = ["cdylib",
"rlib"]` and

```toml
[profile.release]
opt-level = "z"
lto = true
codegen-units = 1
panic = "abort"
strip = true
```

built with `cargo build --release --target wasm32-unknown-unknown`.
`pdfmin`'s `src/lib.rs` (depends on `pdf-writer = "0.15.0"` and
`miniz_oxide = "0.9.1"`):

```rust
//! Chapter 06's size probe of the smaller PDF module: the core hands over each
//! music glyph's outline once (drawn as a form XObject, as the SVG <use>s it)
//! and each text font's file with the glyph ids, advances and characters it
//! used; the module only writes and deflates. Nothing parses a font here.
use miniz_oxide::deflate::compress_to_vec_zlib;
use pdf_writer::types::{CidFontType, FontFlags, SystemInfo, UnicodeCmap};
use pdf_writer::{Content, Filter, Finish, Name, Pdf, Rect, Ref, Str};

struct Reader<'a> { data: &'a [u8], at: usize }
impl<'a> Reader<'a> {
    fn u8(&mut self) -> Option<u8> { let b = *self.data.get(self.at)?; self.at += 1; Some(b) }
    fn u16(&mut self) -> Option<u16> { Some(u16::from_le_bytes([self.u8()?, self.u8()?])) }
    fn f32(&mut self) -> Option<f32> {
        let b = self.data.get(self.at..self.at + 4)?; self.at += 4;
        Some(f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }
    fn bytes(&mut self, n: usize) -> Option<&'a [u8]> { let b = self.data.get(self.at..self.at + n)?; self.at += n; Some(b) }
    fn floats(&mut self) -> Option<Vec<f32>> { let n = self.u16()?; (0..n).map(|_| self.f32()).collect() }
}

fn path(content: &mut Content, points: &[f32], width: f32, fill: bool) -> Option<()> {
    content.set_line_width(width).move_to(*points.first()?, *points.get(1)?);
    for c in points.get(2..)?.chunks_exact(6) { content.cubic_to(c[0], c[1], c[2], c[3], c[4], c[5]); }
    if fill { content.close_path().fill_nonzero(); } else { content.stroke(); }
    Some(())
}

/// Ops: 0 page w h; 1 glyph-def id points; 2 glyph id x y scale; 3 font file widths;
/// 4 text font x y size gids+chars; 5 rect; 6 line; 7 curve points width fill.
pub fn render(ops: &[u8]) -> Option<Vec<u8>> {
    let mut pdf = Pdf::new();
    let mut next = Ref::new(1);
    let mut alloc = || next.bump();
    let (catalog, tree) = (alloc(), alloc());
    pdf.catalog(catalog).pages(tree);
    let mut r = Reader { data: ops, at: 0 };
    let mut glyphs: Vec<Ref> = Vec::new();
    let mut fonts: Vec<(Ref, Vec<(u16, char)>)> = Vec::new();
    let mut pages: Vec<((f32, f32), Content)> = Vec::new();
    let info = SystemInfo { registry: Str(b"Adobe"), ordering: Str(b"Identity"), supplement: 0 };
    while let Some(op) = r.u8() {
        match op {
            0 => pages.push(((r.f32()?, r.f32()?), Content::new())),
            1 => {
                let points = r.floats()?;
                let mut c = Content::new(); path(&mut c, &points, 0.0, true)?;
                let id = alloc(); glyphs.push(id);
                let data = compress_to_vec_zlib(&c.finish(), 6);
                pdf.form_xobject(id, &data).bbox(Rect::new(-1e4, -1e4, 1e4, 1e4)).filter(Filter::FlateDecode);
            }
            2 => {
                let (g, x, y, s) = (r.u16()?, r.f32()?, r.f32()?, r.f32()?);
                let c = &mut pages.last_mut()?.1;
                c.save_state().transform([s, 0.0, 0.0, s, x, y])
                    .x_object(Name(format!("G{g}").as_bytes())).restore_state();
            }
            3 => {
                let len = r.u16()? as usize * 1024; let file = r.bytes(len)?; let widths = r.floats()?;
                let (id, cid, descriptor, stream) = (alloc(), alloc(), alloc(), alloc());
                let name = Name(b"ABCDEF+Text");
                pdf.type0_font(id).base_font(name).encoding_predefined(Name(b"Identity-H")).descendant_font(cid);
                let mut c = pdf.cid_font(cid);
                c.subtype(CidFontType::Type0).base_font(name).system_info(info).font_descriptor(descriptor);
                c.widths().consecutive(0, widths.iter().copied()); c.finish();
                pdf.font_descriptor(descriptor).name(name).flags(FontFlags::NON_SYMBOLIC)
                    .bbox(Rect::new(0.0, -300.0, 1000.0, 1000.0)).italic_angle(0.0).ascent(800.0)
                    .descent(-200.0).cap_height(700.0).stem_v(80.0).font_file3(stream);
                pdf.stream(stream, &compress_to_vec_zlib(file, 6)).filter(Filter::FlateDecode)
                    .pair(Name(b"Subtype"), Name(b"OpenType"));
                fonts.push((id, Vec::new()));
            }
            4 => {
                let (f, x, y, size, n) = (r.u8()? as usize, r.f32()?, r.f32()?, r.f32()?, r.u16()?);
                let mut codes = Vec::new();
                for _ in 0..n {
                    let (g, ch) = (r.u16()?, char::from_u32(r.u16()? as u32)?);
                    codes.extend(g.to_be_bytes()); fonts.get_mut(f)?.1.push((g, ch));
                }
                pages.last_mut()?.1.begin_text().set_font(Name(format!("F{f}").as_bytes()), size)
                    .next_line(x, y).show(Str(&codes)).end_text();
            }
            5 => { let (x, y, w, h) = (r.f32()?, r.f32()?, r.f32()?, r.f32()?); pages.last_mut()?.1.rect(x, y, w, h).fill_nonzero(); }
            6 => {
                let (x1, y1, x2, y2, w) = (r.f32()?, r.f32()?, r.f32()?, r.f32()?, r.f32()?);
                pages.last_mut()?.1.set_line_width(w).move_to(x1, y1).line_to(x2, y2).stroke();
            }
            _ => { let points = r.floats()?; let (w, fill) = (r.f32()?, r.u8()? != 0); path(&mut pages.last_mut()?.1, &points, w, fill)?; }
        }
    }
    for (id, used) in &fonts {
        let cmap = alloc();
        let mut unicode = UnicodeCmap::new(Name(b"Custom"), info);
        for &(g, ch) in used { unicode.pair(g, ch); }
        pdf.cmap(cmap, &unicode.finish()).finish();
        let _ = (id, cmap); // a real module sets the font's /ToUnicode here
    }
    let mut kids = Vec::new();
    for ((w, h), content) in pages {
        let (page, stream) = (alloc(), alloc());
        kids.push(page);
        let mut p = pdf.page(page);
        p.media_box(Rect::new(0.0, 0.0, w, h)).parent(tree).contents(stream);
        let mut resources = p.resources();
        let mut x = resources.x_objects();
        for (i, g) in glyphs.iter().enumerate() { x.pair(Name(format!("G{i}").as_bytes()), *g); }
        x.finish();
        let mut f = resources.fonts();
        for (i, (id, _)) in fonts.iter().enumerate() { f.pair(Name(format!("F{i}").as_bytes()), *id); }
        f.finish(); resources.finish(); p.finish();
        pdf.stream(stream, &compress_to_vec_zlib(&content.finish(), 6)).filter(Filter::FlateDecode);
    }
    pdf.pages(tree).kids(kids.iter().copied()).count(kids.len() as i32);
    Some(pdf.finish())
}

#[unsafe(no_mangle)]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len); let p = v.as_mut_ptr(); core::mem::forget(v); p
}

/// Returns the PDF as a pointer to a u32 length followed by the bytes, or null.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pdf(input: *const u8, len: usize) -> *mut u8 {
    let data = unsafe { core::slice::from_raw_parts(input, len) };
    match render(data) {
        Some(out) => { let mut v = (out.len() as u32).to_le_bytes().to_vec(); v.extend(out); let p = v.as_mut_ptr(); core::mem::forget(v); p }
        None => core::ptr::null_mut(),
    }
}
```

`pdfmod` (adds `ttf-parser = "0.25.1"` and `subsetter = "0.2.6"`) takes the
OpenType files themselves: it maps text to glyph ids with `ttf-parser`'s
`glyph_index`, records every glyph used in a `subsetter::GlyphRemapper`,
draws music glyphs and text alike as CID text (`Identity-H`), takes the
widths from `glyph_hor_advance`, writes each font as `subsetter::subset(data,
0, &remapper)` in a `FontFile3` stream of subtype `OpenType`, with a
`ToUnicode` CMap. `pdfttf` is `pdfmod` with the remapper replaced by a
`Vec<u16>` of glyph ids and the whole font file written instead of the
subset.

**LilyPond's PDFs** (§7.1): `lilypond --pdf` as in chapter 00 §3, then the
`/FontName`s and the `/Length` of the streams whose `/Subtype` is
`Type1C`, `CIDFontType0C` or `OpenType`, read from the file.
