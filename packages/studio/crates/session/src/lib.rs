//! Lily Studio's main process without a window (DECISIONS D42, D55): the
//! state the commands share (`studio`), the commands themselves without their
//! dialogs (`ops`), each score's playback setup, the recent list and Export
//! MIDI. The app (src-tauri) adds native dialogs, the menu and the IPC; the
//! web server's workers (crates/server) add the page's own dialogs and the
//! socket.

pub mod midi_export;
pub mod ops;
pub mod playback;
pub mod recent;
pub mod studio;

pub use ops::{MutedPart, Opened, RecentAnswer, Shown, TemplateInfo, templates};
pub use studio::{Paths, Sink, Studio, StudioEvent, StudioOptions, lock};
