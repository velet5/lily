//! A stripped-down engine to time on phones (docs/research/wasm-engine/09-spike.md):
//! notes, rests and durations on one staff, a tiny Scheme, SVG pages with
//! point-and-click links and LilyPond's diagnostics. Built with chapter 08
//! §1.3's settings it is a core behind chapter 08 §4.2's C ABI, so the
//! studio's engine worker (`packages/studio/src/web/engine/`) runs it as it
//! will run the real one. It is a measuring instrument, not the start of the
//! engine: it recomputes everything on every compile.

pub mod font;
pub mod layout;
pub mod music;
pub mod scheme;
pub mod svg;
pub mod text;

use font::Font;
use layout::Layout;
use music::{Needs, Parsed, Parser, Severity};
use scheme::{Interp, Value};
use std::collections::BTreeMap;
use std::rc::Rc;
use text::{location, push_int, push_json, push_num};

/// `lily_step`'s answers (protocol.ts `Step`).
pub const DONE: u32 = 0;
pub const MORE: u32 = 1;
pub const NEEDS: u32 = 2;
/// `lily_put`'s and `lily_needs`' kinds (protocol.ts `Need`).
pub const FILE: u32 = 0;
pub const MODULE: u32 = 1;
/// The font pack the manifest preloads.
pub const FONT_PACK: &str = "emmentaler-20";

#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "env")]
unsafe extern "C" {
    fn lily_now() -> f64;
}

/// Milliseconds, from the host's clock.
#[cfg(target_arch = "wasm32")]
pub fn now() -> f64 {
    unsafe { lily_now() }
}

#[cfg(not(target_arch = "wasm32"))]
pub fn now() -> f64 {
    use std::sync::OnceLock;
    use std::time::Instant;
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_secs_f64() * 1000.0
}

/// Bytes of linear memory: its high-water mark, since it never shrinks (B4).
fn memory() -> usize {
    #[cfg(target_arch = "wasm32")]
    return core::arch::wasm32::memory_size(0) * 65536;
    #[cfg(not(target_arch = "wasm32"))]
    0
}

enum Phase {
    Parse,
    Layout(Parsed),
    /// The pages written so far: one per pass, so that a newer edit can stop a long score between pages.
    Write(Parsed, Layout, Vec<(String, String)>),
    Done,
}

#[derive(Default)]
struct Stats {
    image_ms: f64,
    parse_ms: f64,
    scheme_ms: f64,
    layout_ms: f64,
    svg_ms: f64,
    longest_step_ms: f64,
    steps: u32,
    restarts: u32,
}

pub struct Engine {
    scheme: Interp,
    /// The interpreter's state after the image: every compile starts from it (B5).
    base: (Vec<Option<Value>>, f64),
    files: BTreeMap<String, Option<Rc<str>>>,
    font: Font,
    root: String,
    phase: Phase,
    needs: Option<(u32, String)>,
    outputs: Vec<(String, Vec<u8>)>,
    stats: Stats,
}

impl Engine {
    /// Starts from the image. Here it is the Scheme prelude as source; chapter
    /// 03 §5.6's image is a heap, restored without evaluating anything.
    pub fn start(image: &[u8]) -> Result<Engine, String> {
        let started = now();
        let mut scheme = Interp::default();
        scheme.eval_all(&String::from_utf8_lossy(image))?;
        let base = scheme.snapshot();
        let stats = Stats {
            image_ms: now() - started,
            ..Stats::default()
        };
        Ok(Engine {
            scheme,
            base,
            files: BTreeMap::new(),
            font: Font::default(),
            root: String::new(),
            phase: Phase::Done,
            needs: None,
            outputs: Vec::new(),
            stats,
        })
    }

    /// A source file (`FILE`; `None`: there is no such file) or a module's data (`MODULE`).
    pub fn put(&mut self, kind: u32, name: &str, data: Option<&[u8]>) {
        match (kind, data) {
            (FILE, data) => {
                let text = data.map(|d| Rc::from(String::from_utf8_lossy(d).as_ref()));
                self.files.insert(name.into(), text);
            }
            (_, Some(data)) if name == FONT_PACK => self.font = Font::parse(data),
            _ => {}
        }
    }

    pub fn compile(&mut self, root: &str) {
        if self.root == root && matches!(self.phase, Phase::Parse) {
            self.stats.restarts += 1;
        } else {
            self.stats = Stats {
                image_ms: self.stats.image_ms,
                ..Stats::default()
            };
        }
        self.root = root.into();
        self.phase = Phase::Parse;
        self.needs = None;
        self.outputs.clear();
    }

    /// Works through the phases until done, until it needs a file, or until
    /// `budget_ms` is spent. Parsing and layout are not split; pages are
    /// written one at a time.
    pub fn step(&mut self, budget_ms: f64) -> u32 {
        let started = now();
        self.stats.steps += 1;
        let answer = loop {
            let phase_started = now();
            match core::mem::replace(&mut self.phase, Phase::Done) {
                Phase::Parse => {
                    self.scheme.restore(&self.base);
                    match Parser::new(&self.files, &mut self.scheme).parse(&self.root) {
                        Ok(parsed) => {
                            self.stats.parse_ms += now() - phase_started;
                            self.stats.scheme_ms += parsed.scheme_ms;
                            self.phase = Phase::Layout(parsed);
                        }
                        Err(Needs(path)) => {
                            self.phase = Phase::Parse;
                            self.needs = Some((FILE, path));
                            break NEEDS;
                        }
                    }
                }
                Phase::Layout(mut parsed) => {
                    let staff_size = self.scheme.staff_size.clamp(8.0, 40.0);
                    if self.font.is_empty() {
                        parsed.diags.push(music::Diag {
                            file: 0,
                            at: 0,
                            severity: Severity::Error,
                            message: "the music font is missing".into(),
                        });
                    }
                    let laid = layout::layout(&parsed.score, &self.font, staff_size);
                    self.stats.layout_ms = now() - phase_started;
                    self.phase = Phase::Write(parsed, laid, Vec::new());
                }
                Phase::Write(parsed, laid, mut pages) => {
                    let errors = parsed.diags.iter().any(|d| d.severity == Severity::Error);
                    if errors || pages.len() == laid.pages.len() {
                        self.finish(&parsed, &laid, pages, started);
                        break DONE;
                    }
                    let i = pages.len();
                    let page = svg::page(&laid.pages[i], &self.font, &parsed.sources, None);
                    pages.push((self.page_name(i, laid.pages.len()), page));
                    self.stats.svg_ms += now() - phase_started;
                    self.phase = Phase::Write(parsed, laid, pages);
                }
                Phase::Done => break DONE,
            }
            if now() - started >= budget_ms {
                break MORE;
            }
        };
        self.stats.longest_step_ms = self.stats.longest_step_ms.max(now() - started);
        answer
    }

    pub fn needs(&self) -> Option<(u32, &str)> {
        self.needs.as_ref().map(|(k, n)| (*k, n.as_str()))
    }

    pub fn outputs(&self) -> &[(String, Vec<u8>)] {
        &self.outputs
    }

    /// LilyPond's names: `<base>.svg`, or `<base>-<n>.svg` when there are several pages.
    fn page_name(&self, i: usize, count: usize) -> String {
        let file = self.root.rsplit('/').next().unwrap_or("score");
        let mut name = file.strip_suffix(".ly").unwrap_or(file).to_owned();
        if count > 1 {
            name.push('-');
            push_int(&mut name, i as i64 + 1);
        }
        name.push_str(".svg");
        name
    }

    /// The outputs: the pages, `stderr` in LilyPond's format and `diagnostics.json` (chapter 08 §6).
    fn finish(
        &mut self,
        parsed: &Parsed,
        laid: &Layout,
        mut pages: Vec<(String, String)>,
        step_started: f64,
    ) {
        // What the harness reads: the phases' times and memory, as a comment in the first page.
        self.stats.longest_step_ms = self.stats.longest_step_ms.max(now() - step_started);
        if let Some((_, first)) = pages.first_mut()
            && let Some(end) = first.find("\">\n")
        {
            first.insert_str(end + 3, &self.stats_comment(laid));
        }
        let mut stderr = String::new();
        let mut json = String::from("[");
        for (i, d) in parsed.diags.iter().enumerate() {
            let (path, src) = parsed
                .sources
                .get(d.file as usize)
                .map_or((self.root.as_str(), ""), |(p, s)| (p.as_str(), s));
            let (line, _, column) = location(src, d.at as usize);
            let severity = if d.severity == Severity::Error {
                "error"
            } else {
                "warning"
            };
            stderr.push_str(path);
            for n in [line, column] {
                stderr.push(':');
                push_int(&mut stderr, n as i64);
            }
            stderr.push_str(": ");
            stderr.push_str(severity);
            stderr.push_str(": ");
            stderr.push_str(&d.message);
            stderr.push('\n');
            // The source line cut at the error, the rest on the next line under it (ARCHITECTURE.md §3.5).
            let start = src[..(d.at as usize).min(src.len())]
                .rfind('\n')
                .map_or(0, |k| k + 1);
            let end = src[start..].find('\n').map_or(src.len(), |k| start + k);
            let cut = (d.at as usize).clamp(start, end);
            stderr.push_str(&src[start..cut]);
            stderr.push('\n');
            for _ in 1..column {
                stderr.push(' ');
            }
            stderr.push_str(&src[cut..end]);
            stderr.push('\n');
            if i > 0 {
                json.push(',');
            }
            json.push_str("{\"file\":");
            push_json(&mut json, path);
            json.push_str(",\"line\":");
            push_int(&mut json, line as i64);
            json.push_str(",\"column\":");
            push_int(&mut json, column as i64);
            json.push_str(",\"severity\":\"");
            json.push_str(severity);
            json.push_str("\",\"message\":");
            push_json(&mut json, &d.message);
            json.push('}');
        }
        json.push(']');
        stderr.push_str(&self.scheme.output);
        self.outputs = pages
            .into_iter()
            .map(|(n, s)| (n, s.into_bytes()))
            .collect();
        self.outputs.push(("stderr".into(), stderr.into_bytes()));
        self.outputs
            .push(("diagnostics.json".into(), json.into_bytes()));
    }

    fn stats_comment(&self, laid: &Layout) -> String {
        let s = &self.stats;
        let mut out = String::from("<!--lily-spike {");
        for (i, (key, value)) in [
            ("imageMs", s.image_ms),
            ("parseMs", s.parse_ms),
            ("schemeMs", s.scheme_ms),
            ("layoutMs", s.layout_ms),
            ("svgMs", s.svg_ms),
            ("longestStepMs", s.longest_step_ms),
            ("steps", s.steps as f64),
            ("restarts", s.restarts as f64),
            ("memory", memory() as f64),
            ("events", laid.events as f64),
            ("systems", laid.systems as f64),
            ("pages", laid.pages.len() as f64),
        ]
        .into_iter()
        .enumerate()
        {
            if i > 0 {
                out.push(',');
            }
            push_json(&mut out, key);
            out.push(':');
            push_num(&mut out, value);
        }
        out.push_str("}-->\n");
        out
    }
}

/// Chapter 08 §4.2's C ABI over one engine per instance.
#[cfg(target_arch = "wasm32")]
mod abi {
    use super::Engine;
    use std::alloc::{Layout, alloc, dealloc};
    use std::cell::UnsafeCell;

    struct Global(UnsafeCell<Option<Engine>>);
    // A wasm instance without threads: one caller at a time.
    unsafe impl Sync for Global {}
    static ENGINE: Global = Global(UnsafeCell::new(None));

    fn engine() -> &'static mut Engine {
        // The host calls lily_start first; anything else before it is a bug, and a trap.
        unsafe {
            (*ENGINE.0.get())
                .as_mut()
                .unwrap_or_else(|| core::arch::wasm32::unreachable())
        }
    }

    unsafe fn bytes<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
        if len == 0 {
            &[]
        } else {
            unsafe { core::slice::from_raw_parts(ptr, len) }
        }
    }

    unsafe fn text<'a>(ptr: *const u8, len: usize) -> &'a str {
        core::str::from_utf8(unsafe { bytes(ptr, len) }).unwrap_or("")
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn lily_alloc(len: usize) -> *mut u8 {
        unsafe { alloc(Layout::from_size_align_unchecked(len.max(1), 1)) }
    }

    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn lily_free(ptr: *mut u8, len: usize) {
        unsafe { dealloc(ptr, Layout::from_size_align_unchecked(len.max(1), 1)) }
    }

    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn lily_start(image: *const u8, len: usize) -> u32 {
        match Engine::start(unsafe { bytes(image, len) }) {
            Ok(e) => {
                unsafe { *ENGINE.0.get() = Some(e) };
                0
            }
            Err(_) => 1,
        }
    }

    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn lily_put(
        kind: u32,
        name: *const u8,
        name_len: usize,
        data: *const u8,
        data_len: usize,
    ) {
        let data = if data.is_null() {
            None
        } else {
            Some(unsafe { bytes(data, data_len) })
        };
        engine().put(kind, unsafe { text(name, name_len) }, data);
    }

    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn lily_compile(
        _revision: u32,
        root: *const u8,
        root_len: usize,
        _visible_page: u32,
    ) {
        engine().compile(unsafe { text(root, root_len) });
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn lily_step(budget_ms: f64) -> u32 {
        engine().step(budget_ms)
    }

    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn lily_needs(out: *mut u32) {
        let (kind, name) = engine().needs().unwrap_or((0, ""));
        unsafe { *out = kind };
        unsafe { *out.add(1) = name.as_ptr() as u32 };
        unsafe { *out.add(2) = name.len() as u32 };
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn lily_outputs() -> u32 {
        engine().outputs().len() as u32
    }

    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn lily_output(i: u32, out: *mut u32) {
        let (name, data) = &engine().outputs()[i as usize];
        unsafe { *out = name.as_ptr() as u32 };
        unsafe { *out.add(1) = name.len() as u32 };
        unsafe { *out.add(2) = data.as_ptr() as u32 };
        unsafe { *out.add(3) = data.len() as u32 };
    }
}
