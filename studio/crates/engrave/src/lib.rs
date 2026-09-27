//! Lily Studio's compile core, without Tauri (DECISIONS D42): the Rust port of
//! the extension's compile service (src/compile/, src/diagnostics/parse.ts,
//! src/preview/liveQueue.ts and pointAndClick.ts) and of what was the
//! Electron studio's main process (compiling, live preview, watching, the
//! LilyPond setup, file access and the templates).
//!
//! Everything the renderer receives serializes to the shapes of
//! studio/src/ipc.ts: camelCase fields, absent optional fields left out, paths
//! as strings and bytes as base64.

pub mod accelerator;
mod collate;
pub mod compile_service;
pub mod compiler;
pub mod files;
pub mod live;
pub mod live_queue;
pub mod locate;
pub mod parse;
pub mod paths;
pub mod point_and_click;
pub mod root_file;
pub mod search_path;
pub mod setup;
pub mod snapshot;
pub mod span;
pub mod templates;
pub mod watcher;

pub use compile_service::{
    CompileEvent, CompileOutcome, CompileState, Compiler, PdfFile, PdfOutcome, PdfState,
    PlaybackTiming, StudioCompiler, StudioCompilerOptions,
};
pub use compiler::{
    Acceleration, CompileError, CompileRequest, CompileResult, CompileService,
    CompileServiceOptions, ExportFormat, ExportRequest, ExportResult,
};
pub use files::{Access, FolderListing, ScoreFile};
pub use live::{LiveCompile, LiveOptions, LiveTarget, LiveTexts};
pub use locate::{LilyPondNotFound, locate_lilypond};
pub use parse::{LyDiagnostic, LySeverity, parse_stderr};
pub use point_and_click::{SourceLocation, parse_text_edit};
pub use root_file::SourceBuffers;
pub use search_path::SearchPath;
pub use setup::{LilyPondStatus, Settings};
pub use watcher::{FileChange, ScoreWatcher};
