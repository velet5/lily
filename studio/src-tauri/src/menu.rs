//! The application menu: only what the studio does (D20, D28). The Edit menu's
//! items are AppKit's own, so copy, paste and undo reach the editor. Items with
//! an id that is a renderer command send it (`Command` in src/ipc.ts).
use tauri::menu::{HELP_SUBMENU_ID, Menu, MenuItemBuilder, SubmenuBuilder, WINDOW_SUBMENU_ID};
use tauri::{AppHandle, Runtime};

/// Menu ids that are renderer commands, as `Command` in src/ipc.ts spells them.
pub const COMMANDS: &[&str] = &[
    "new-score",
    "open-file",
    "open-folder",
    "save",
    "save-all",
    "welcome",
    "setup-lilypond",
];
/// Help › LilyPond Learning Manual, opened in the browser.
pub const LEARN: &str = "learn";

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
    let file = SubmenuBuilder::new(app, "File")
        .item(&item("new-score", "New Score…", "CmdOrCtrl+N")?)
        .item(&item("open-file", "Open Score…", "CmdOrCtrl+O")?)
        .item(&item("open-folder", "Open Folder…", "CmdOrCtrl+Shift+O")?)
        .separator()
        .item(&item("save", "Save", "CmdOrCtrl+S")?)
        .item(&item("save-all", "Save All", "CmdOrCtrl+Alt+S")?)
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
