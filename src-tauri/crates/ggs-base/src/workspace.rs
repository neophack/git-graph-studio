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
