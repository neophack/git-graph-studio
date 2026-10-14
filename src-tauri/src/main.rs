//! Git Graph Studio: the desktop app. Everything lives in the library crate (`lib.rs`).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    git_graph_studio_lib::run();
}
