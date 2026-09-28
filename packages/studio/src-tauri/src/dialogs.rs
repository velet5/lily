//! The studio's native dialogs, straight from AppKit (DECISIONS D42): open and
//! save panels, alerts, and the window's unsaved-changes dot. Each runs on the
//! main thread, application-modal, and the async caller waits for the answer.
//! AppKit's own panels do what the setup needs and Tauri's dialog plugin
//! cannot: one panel that takes a file or a folder, a message above the list,
//! hidden files shown.
use std::path::PathBuf;

use tauri::{AppHandle, WebviewWindow};
use tokio::sync::oneshot;

/// An open panel: a file, a folder, or either.
#[derive(Default)]
pub struct Open {
    pub title: String,
    /// Shown above the list.
    pub message: Option<String>,
    /// The default button's title; "Open" when absent.
    pub prompt: Option<String>,
    pub files: bool,
    pub directories: bool,
    pub create_directories: bool,
    pub hidden_files: bool,
    /// Extensions without the dot; any file when empty.
    pub extensions: Vec<String>,
    pub directory: Option<PathBuf>,
}

/// A save panel, which asks before replacing a file.
#[derive(Default)]
pub struct Save {
    pub title: String,
    pub prompt: Option<String>,
    pub directory: Option<PathBuf>,
    pub name: Option<String>,
    pub extensions: Vec<String>,
}

/// An alert; the first button is the default, a "Cancel" button answers Escape.
pub struct Alert {
    pub message: String,
    pub detail: String,
    /// From the right, as AppKit lays them out.
    pub buttons: Vec<String>,
}

/// Runs `show` on the main thread and waits for what it returns.
async fn on_main<T: Send + 'static>(
    app: &AppHandle,
    show: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    let (tx, rx) = oneshot::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(show());
    })
    .map_err(|error| error.to_string())?;
    rx.await
        .map_err(|_| "The dialog was closed with the application.".to_string())
}

/// The chosen path, or None when the panel was cancelled.
pub async fn open(app: &AppHandle, options: Open) -> Result<Option<PathBuf>, String> {
    on_main(app, move || mac::open(options)).await
}

pub async fn save(app: &AppHandle, options: Save) -> Result<Option<PathBuf>, String> {
    on_main(app, move || mac::save(options)).await
}

/// The index of the button that was pressed.
pub async fn alert(app: &AppHandle, options: Alert) -> Result<usize, String> {
    on_main(app, move || mac::alert(options)).await
}

/// The dot in the window's close button while any file has unsaved changes.
pub fn set_edited(window: &WebviewWindow, edited: bool) {
    let target = window.clone();
    let _ = window.run_on_main_thread(move || mac::set_edited(&target, edited));
}

#[cfg(target_os = "macos")]
mod mac {
    use std::path::PathBuf;

    use objc2::MainThreadMarker;
    use objc2_app_kit::{
        NSAlert, NSAlertFirstButtonReturn, NSAlertStyle, NSModalResponseOK, NSOpenPanel,
        NSSavePanel, NSWindow,
    };
    use objc2_foundation::{NSArray, NSString, NSURL};
    use tauri::WebviewWindow;

    use super::{Alert, Open, Save};

    fn main_thread() -> MainThreadMarker {
        MainThreadMarker::new().expect("dialogs run on the main thread")
    }

    fn url(path: &std::path::Path) -> Option<objc2::rc::Retained<NSURL>> {
        path.to_str()
            .map(|path| NSURL::fileURLWithPath(&NSString::from_str(path)))
    }

    fn path(url: Option<objc2::rc::Retained<NSURL>>) -> Option<PathBuf> {
        url.and_then(|url| url.path())
            .map(|path| PathBuf::from(path.to_string()))
    }

    #[allow(deprecated)] // allowedContentTypes needs a UTType per extension; .ly has none.
    fn common(
        panel: &NSSavePanel,
        title: &str,
        prompt: Option<&str>,
        directory: Option<&std::path::Path>,
        extensions: &[String],
    ) {
        panel.setTitle(Some(&NSString::from_str(title)));
        if let Some(prompt) = prompt {
            panel.setPrompt(Some(&NSString::from_str(prompt)));
        }
        if let Some(directory) = directory.and_then(url) {
            panel.setDirectoryURL(Some(&directory));
        }
        if !extensions.is_empty() {
            let types: Vec<_> = extensions.iter().map(|e| NSString::from_str(e)).collect();
            panel.setAllowedFileTypes(Some(&NSArray::from_retained_slice(&types)));
        }
    }

    pub fn open(options: Open) -> Option<PathBuf> {
        let panel = NSOpenPanel::openPanel(main_thread());
        common(
            &panel,
            &options.title,
            options.prompt.as_deref(),
            options.directory.as_deref(),
            &options.extensions,
        );
        if let Some(message) = &options.message {
            panel.setMessage(Some(&NSString::from_str(message)));
        }
        panel.setCanChooseFiles(options.files);
        panel.setCanChooseDirectories(options.directories);
        panel.setAllowsMultipleSelection(false);
        panel.setCanCreateDirectories(options.create_directories);
        panel.setShowsHiddenFiles(options.hidden_files);
        if panel.runModal() != NSModalResponseOK {
            return None;
        }
        path(panel.URL())
    }

    pub fn save(options: Save) -> Option<PathBuf> {
        let panel = NSSavePanel::savePanel(main_thread());
        common(
            &panel,
            &options.title,
            options.prompt.as_deref(),
            options.directory.as_deref(),
            &options.extensions,
        );
        if let Some(name) = &options.name {
            panel.setNameFieldStringValue(&NSString::from_str(name));
        }
        panel.setCanCreateDirectories(true);
        panel.setShowsTagField(false);
        if panel.runModal() != NSModalResponseOK {
            return None;
        }
        path(panel.URL())
    }

    pub fn alert(options: Alert) -> usize {
        let alert = NSAlert::new(main_thread());
        alert.setAlertStyle(NSAlertStyle::Warning);
        alert.setMessageText(&NSString::from_str(&options.message));
        alert.setInformativeText(&NSString::from_str(&options.detail));
        for button in &options.buttons {
            alert.addButtonWithTitle(&NSString::from_str(button));
        }
        usize::try_from(alert.runModal() - NSAlertFirstButtonReturn).unwrap_or(0)
    }

    pub fn set_edited(window: &WebviewWindow, edited: bool) {
        if let Ok(pointer) = window.ns_window() {
            // SAFETY: Tauri's window handle is an NSWindow, alive while `window` is.
            let ns_window = unsafe { &*pointer.cast::<NSWindow>() };
            ns_window.setDocumentEdited(edited);
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod mac {
    //! Lily Studio is built for macOS (D28); elsewhere the dialogs answer "cancelled".
    use std::path::PathBuf;

    use tauri::WebviewWindow;

    use super::{Alert, Open, Save};

    pub fn open(_: Open) -> Option<PathBuf> {
        None
    }
    pub fn save(_: Save) -> Option<PathBuf> {
        None
    }
    pub fn alert(options: Alert) -> usize {
        options.buttons.len().saturating_sub(1)
    }
    pub fn set_edited(_: &WebviewWindow, _: bool) {}
}
