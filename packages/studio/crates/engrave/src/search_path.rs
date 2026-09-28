//! The `PATH` that lilypond runs with. The Electron studio widened
//! `process.env.PATH` (D37); here nothing mutates the process environment.
//! The app keeps one shared `SearchPath`, and every lilypond spawn (compiles,
//! the warm worker, the probe, `--version`) passes it as the child's `PATH`,
//! and locating lilypond on `PATH` reads it.

use std::sync::{Arc, RwLock};

/// A cheap, cloneable handle on one `PATH` value; clones share it.
#[derive(Debug, Clone, Default)]
pub struct SearchPath(Arc<RwLock<String>>);

impl SearchPath {
    pub fn new(value: impl Into<String>) -> Self {
        Self(Arc::new(RwLock::new(value.into())))
    }

    /// The process's own `PATH` at the time of the call, empty when unset.
    pub fn from_env() -> Self {
        Self::new(std::env::var("PATH").unwrap_or_default())
    }

    pub fn get(&self) -> String {
        match self.0.read() {
            Ok(value) => value.clone(),
            Err(poisoned) => poisoned.into_inner().clone(),
        }
    }

    pub fn set(&self, value: impl Into<String>) {
        let value = value.into();
        match self.0.write() {
            Ok(mut guard) => *guard = value,
            Err(poisoned) => *poisoned.into_inner() = value,
        }
    }
}
