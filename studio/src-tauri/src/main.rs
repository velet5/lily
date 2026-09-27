// No console window on Windows in release; Lily Studio is built for macOS (D28).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    lily_studio::run()
}
