//! The app tests' isolated extension store (cfg(test) only): pins cmd_ext's store to a
//! temporary empty directory and stops any backend the developer's real store left
//! warm, so "nothing installed" assertions hold on any machine — not just one whose
//! `~/.ggs` happens to be empty. Lives here (not in ggs-testkit) because it reaches
//! the app's own cfg(test) state.

pub struct IsolatedExtensionStore {
    _dir: tempfile::TempDir,
}

impl Drop for IsolatedExtensionStore {
    fn drop(&mut self) {
        crate::ext_process::host().stop_all();
        crate::cmd_ext::unpin_extensions_home();
    }
}

pub fn isolated_extension_store() -> IsolatedExtensionStore {
    let dir = tempfile::tempdir().expect("a tempdir for the isolated extension store");
    crate::cmd_ext::pin_extensions_home(dir.path().to_path_buf());
    crate::ext_process::host().stop_all();
    IsolatedExtensionStore { _dir: dir }
}
