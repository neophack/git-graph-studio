//! Repository-root discovery over the open workspace's roots — the pure half of what
//! `AppState::resolve_repo` confirms in the app (P3-13 moves the state itself).

/// The nearest ancestor of `path` (itself included) that holds a `.git` directory or file
/// (a worktree / submodule checkout): what `git rev-parse --show-toplevel` answers,
/// without git.
pub fn find_repo_root(path: &str) -> Option<String> {
    let mut current = Some(std::path::Path::new(path));
    while let Some(dir) = current {
        if dir.join(".git").exists() {
            return Some(dir.to_string_lossy().trim_start_matches(r"\\?\").to_owned());
        }
        current = dir.parent();
    }
    None
}

/// Whether `path` is a git checkout (a `.git` directory or file) strictly inside one of
/// `roots`, spelled without `..` segments - the shape a submodule root takes.
pub fn is_repo_below(roots: &[String], path: &str) -> bool {
    use std::path::{Component, Path};
    let candidate = Path::new(path);
    if candidate
        .components()
        .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
    {
        return false;
    }
    let normalised = |p: &str| p.replace('\\', "/").trim_end_matches('/').to_lowercase();
    let wanted = normalised(path);
    roots.iter().any(|root| {
        let root = normalised(root);
        wanted.len() > root.len() + 1
            && wanted.starts_with(&root)
            && wanted.as_bytes()[root.len()] == b'/'
    }) && candidate.join(".git").exists()
}

/// The open workspace roots — the state half of the workspace services (the plan's
/// §4.6: `repos` leaves the app's god-state and lives here, managed by the app and
/// injected by the commands that need it). The standalone shell works with one folder
/// at a time, but the Git Graph view was built around a repo set, so the state stays
/// a list.
pub struct WorkspaceRoots {
    repos: std::sync::Mutex<Vec<String>>,
    /// The `.ggs-workspace` file the roots came from, if any: a frontend attaching to an
    /// already-open window (a remote session) restores the whole workspace from it, not
    /// just the first root (`boot_context`'s answer).
    workspace: std::sync::Mutex<Option<String>>,
}

impl Default for WorkspaceRoots {
    fn default() -> Self {
        WorkspaceRoots {
            repos: std::sync::Mutex::new(Vec::new()),
            workspace: std::sync::Mutex::new(None),
        }
    }
}

impl WorkspaceRoots {
    /// The open roots, cloned (a snapshot for a handshake or a status answer).
    pub fn list(&self) -> Vec<String> {
        self.repos.lock().unwrap().clone()
    }

    /// The first open root — the default repository of the git-backed views.
    pub fn first(&self) -> Option<String> {
        self.repos.lock().unwrap().first().cloned()
    }

    /// Replace the open roots (an open-folder/open-workspace pass sets them whole).
    pub fn set(&self, roots: Vec<String>) {
        *self.repos.lock().unwrap() = roots;
    }

    /// The workspace file the roots came from (`None` when a plain folder is open).
    pub fn workspace(&self) -> Option<String> {
        self.workspace.lock().unwrap().clone()
    }

    /// Record which `.ggs-workspace` file the current roots came from (an open-folder
    /// pass clears it with `None`).
    pub fn set_workspace(&self, file: Option<String>) {
        *self.workspace.lock().unwrap() = file;
    }

    /// Drop every root (a close, or a switch into single-file mode).
    pub fn clear(&self) {
        self.repos.lock().unwrap().clear();
        *self.workspace.lock().unwrap() = None;
    }

    /// Whether `root` is already the first open root (a reopen keeps the warm handles).
    pub fn first_is(&self, root: &str) -> bool {
        self.repos
            .lock()
            .unwrap()
            .first()
            .is_some_and(|open| open == root)
    }

    /// The repository a Source Control command acts on: the open repository when the
    /// view names none, otherwise the named one — which must be an open root or a
    /// checkout below one (a submodule the view lists as its own section). Anything
    /// else is refused: the frontend never gets to run git in an arbitrary folder.
    pub fn resolve_repo(&self, repo: Option<String>) -> Result<String, String> {
        let repos = self.repos.lock().unwrap();
        let Some(repo) = repo else {
            return repos
                .first()
                .cloned()
                .ok_or_else(|| "No repository is open".to_string());
        };
        if repos.contains(&repo) {
            return Ok(repo);
        }
        if is_repo_below(&repos, &repo) {
            return Ok(repo);
        }
        Err(format!("{repo} is not a repository of the open folder"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ggs-base-workspace-{}-{}", std::process::id(), name));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn repo_root_walks_up_to_git() {
        let dir = scratch("find");
        fs::create_dir_all(dir.join("src/deep")).unwrap();
        assert_eq!(find_repo_root(&dir.join("src/deep").display().to_string()), None);
        fs::create_dir_all(dir.join(".git")).unwrap();
        let found = find_repo_root(&dir.join("src/deep").display().to_string()).unwrap();
        assert_eq!(
            PathBuf::from(&found).canonicalize().unwrap(),
            dir.canonicalize().unwrap()
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn repo_below_requires_git_and_strict_containment() {
        let root = scratch("below");
        fs::create_dir_all(root.join("sub/.git")).unwrap();
        fs::create_dir_all(root.join("plain")).unwrap();
        let roots = [root.display().to_string()];
        let path = |p: &std::path::Path| p.display().to_string();
        assert!(is_repo_below(&roots, &path(&root.join("sub"))));
        assert!(!is_repo_below(&roots, &path(&root.join("plain"))));
        assert!(!is_repo_below(&roots, &path(&root)));
        // No `..` segments.
        let dotted = format!("{}/../sub", root.join("elsewhere").display());
        assert!(!is_repo_below(&roots, &dotted));
        // Backslashes normalise.
        assert!(is_repo_below(
            &roots,
            &path(&root.join("sub")).replace('\\', "/")
        ));
        let _ = fs::remove_dir_all(&root);
    }
}
