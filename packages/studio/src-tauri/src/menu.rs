//! The application menu: only what the studio does (D20, D28). The Edit menu's
//! items are AppKit's own, so copy, paste and undo reach the editor. Items with
//! an id that is a renderer command send it (`Command` in src/ipc.ts). File ›
//! Open Recent lists the recent list (D49) and is filled again when it changes.
use std::path::Path;

use tauri::menu::{
    HELP_SUBMENU_ID, Menu, MenuItemBuilder, PredefinedMenuItem, Submenu, SubmenuBuilder,
    WINDOW_SUBMENU_ID,
};
use tauri::{AppHandle, Runtime};

use crate::recent::{RecentEntry, tilde};

/// Menu ids that are renderer commands, as `Command` in src/ipc.ts spells them.
pub const COMMANDS: &[&str] = &[
    "new-score",
    "open-file",
    "open-folder",
    "save",
    "save-all",
    "export-midi",
    "welcome",
    "setup-lilypond",
];
/// Help › LilyPond Learning Manual, opened in the browser.
pub const LEARN: &str = "learn";
/// An item of Open Recent is this and the entry's path.
pub const RECENT_PREFIX: &str = "recent:";
/// Open Recent › Clear Menu.
pub const RECENT_CLEAR: &str = "recent-clear";
const FILE_MENU: &str = "file";
const RECENT_MENU: &str = "open-recent";

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let item = |id: &str, text: &str, accelerator: &str| {
        MenuItemBuilder::with_id(id, text)
            .accelerator(accelerator)
            .build(app)
    };
    let app_menu = SubmenuBuilder::new(app, "Lily Studio")
        .about(None)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;
    let recent = SubmenuBuilder::with_id(app, RECENT_MENU, "Open Recent").build()?;
    let file = SubmenuBuilder::with_id(app, FILE_MENU, "File")
        .item(&item("new-score", "New Score…", "CmdOrCtrl+N")?)
        .item(&item("open-file", "Open Score…", "CmdOrCtrl+O")?)
        .item(&item("open-folder", "Open Folder…", "CmdOrCtrl+Shift+O")?)
        .item(&recent)
        .separator()
        .item(&item("save", "Save", "CmdOrCtrl+S")?)
        .item(&item("save-all", "Save All", "CmdOrCtrl+Alt+S")?)
        .separator()
        .text("export-midi", "Export MIDI…")
        .separator()
        .close_window()
        .build()?;
    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let window = SubmenuBuilder::with_id(app, WINDOW_SUBMENU_ID, "Window")
        .minimize()
        .maximize()
        .separator()
        .bring_all_to_front()
        .build()?;
    let help = SubmenuBuilder::with_id(app, HELP_SUBMENU_ID, "Help")
        .text("welcome", "Welcome")
        .text("setup-lilypond", "Set Up LilyPond…")
        .separator()
        .text(LEARN, "LilyPond Learning Manual")
        .build()?;
    Menu::with_items(app, &[&app_menu, &file, &edit, &window, &help])
}

/// Fills File › Open Recent with `entries`, newest first, and Clear Menu.
/// Run on the main thread.
pub fn fill_recent<R: Runtime>(app: &AppHandle<R>, entries: &[RecentEntry]) -> tauri::Result<()> {
    let Some(submenu) = recent_submenu(app) else {
        return Ok(());
    };
    for item in submenu.items()? {
        submenu.remove(&item)?;
    }
    let home = std::env::var_os("HOME").map(std::path::PathBuf::from);
    let labels = recent_labels(entries, home.as_deref());
    for (entry, label) in entries.iter().zip(labels) {
        let id = format!("{RECENT_PREFIX}{}", entry.path);
        submenu.append(&MenuItemBuilder::with_id(id, label).build(app)?)?;
    }
    if !entries.is_empty() {
        submenu.append(&PredefinedMenuItem::separator(app)?)?;
    }
    let clear = MenuItemBuilder::with_id(RECENT_CLEAR, "Clear Menu")
        .enabled(!entries.is_empty())
        .build(app)?;
    submenu.append(&clear)
}

fn recent_submenu<R: Runtime>(app: &AppHandle<R>) -> Option<Submenu<R>> {
    let file = app.menu()?.get(FILE_MENU)?.as_submenu()?.clone();
    file.get(RECENT_MENU)?.as_submenu().cloned()
}

/// Each entry's name, and its parent directory where another has the same name.
pub fn recent_labels(entries: &[RecentEntry], home: Option<&Path>) -> Vec<String> {
    let name = |entry: &RecentEntry| {
        Path::new(&entry.path)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| entry.path.clone())
    };
    entries
        .iter()
        .map(|entry| {
            let own = name(entry);
            let shared = entries.iter().filter(|other| name(other) == own).count() > 1;
            match Path::new(&entry.path).parent() {
                Some(parent) if shared => format!("{own} — {}", tilde(parent, home)),
                _ => own,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::recent::RecentKind;

    #[test]
    fn a_shared_name_shows_its_directory() {
        let entry = |path: &str| RecentEntry {
            path: path.into(),
            kind: RecentKind::File,
            opened: 0,
        };
        let entries = [
            entry("/Users/me/a/main.ly"),
            entry("/Volumes/T5/main.ly"),
            entry("/Users/me/song.ly"),
        ];
        assert_eq!(
            recent_labels(&entries, Some(Path::new("/Users/me"))),
            ["main.ly — ~/a", "main.ly — /Volumes/T5", "song.ly"]
        );
    }
}
