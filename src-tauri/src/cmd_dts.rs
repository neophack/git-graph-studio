//! The Device Tree commands' thin adapters (module 22): the one #[tauri::command] the
//! device tree view knows — the blob and source parsing live in the ggs-dts crate
//! (parse reads the magic and picks). This is the only device tree file that may name
//! tauri.

use ggs_dts::DtsDocument;

/// Parses the file at `path` — a `.dtb` blob by its magic, `.dts`/`.dtsi` text
/// otherwise — and answers the whole tree (a device tree is small).
#[tauri::command]
pub async fn devtree_open(path: String) -> Result<DtsDocument, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("{}: {}", path, e))?;
    let total = bytes.len() as u64;
    if total > ggs_dts::MAX_FILE {
        return Err(format!("{}: past the 32 MiB this viewer accepts", path));
    }
    tauri::async_runtime::spawn_blocking(move || ggs_dts::parse(&bytes, total))
        .await
        .map_err(|e| e.to_string())?
}
