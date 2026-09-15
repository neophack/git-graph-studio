//! Scratch repositories for the tests: a temporary directory with a scratch global git config
//! (so "global" writes never touch the developer's own ~/.gitconfig), plus the small helpers the
//! tests build histories with.
#![cfg(test)]

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use crate::git::Git;

static COUNTER: AtomicUsize = AtomicUsize::new(0);

pub struct Scratch {
    pub root: PathBuf,
}

impl Scratch {
    pub fn new(name: &str) -> Scratch {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let root = std::env::temp_dir().join(format!(
            "git-graph-studio-test-{}-{}-{n}",
            std::process::id(),
            name
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        // A scratch global config, so --global writes stay inside the test.
        fs::write(root.join("gitconfig"), "[init]\n\tdefaultBranch = main\n").unwrap();
        Scratch { root }
    }

    pub fn path(&self, name: &str) -> PathBuf {
        self.root.join(name)
    }

    pub fn git(&self, repo: &Path) -> Git {
        let mut git = Git::new(repo);
        let scratch_config = self.root.join("gitconfig").display().to_string();
        git.env = vec![
            ("GIT_CONFIG_GLOBAL".into(), scratch_config),
            ("GIT_CONFIG_NOSYSTEM".into(), "1".into()),
            ("HOME".into(), self.root.display().to_string()),
            ("GIT_AUTHOR_NAME".into(), "Test".into()),
            ("GIT_AUTHOR_EMAIL".into(), "test@example.com".into()),
            ("GIT_COMMITTER_NAME".into(), "Test".into()),
            ("GIT_COMMITTER_EMAIL".into(), "test@example.com".into()),
        ];
        git
    }

    /// A fresh non-bare repository with one commit on `main`.
    pub fn repo(&self, name: &str) -> Git {
        let path = self.path(name);
        fs::create_dir_all(&path).unwrap();
        let git = self.git(&path);
        git.run(&["init", "-q", "-b", "main"]).unwrap();
        commit(&git, "README.md", "hello\n", "Initial commit");
        git
    }

    /// A bare repository, used as a remote.
    pub fn bare(&self, name: &str) -> PathBuf {
        let path = self.path(name);
        fs::create_dir_all(&path).unwrap();
        self.git(&path)
            .run(&["init", "-q", "--bare", "-b", "main"])
            .unwrap();
        path
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

pub fn write(git: &Git, file: &str, content: &str) {
    let path = git.repo.join(file);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(path, content).unwrap();
}

pub fn commit(git: &Git, file: &str, content: &str, message: &str) -> String {
    write(git, file, content);
    git.run(&["add", "--", file]).unwrap();
    git.run(&["commit", "-q", "-m", message]).unwrap();
    head(git)
}

pub fn head(git: &Git) -> String {
    git.output(&["rev-parse", "HEAD"])
        .unwrap()
        .trim()
        .to_owned()
}

pub fn rev(git: &Git, spec: &str) -> String {
    git.output(&["rev-parse", spec]).unwrap().trim().to_owned()
}

pub fn subject(git: &Git, spec: &str) -> String {
    git.output(&["log", "-1", "--format=%s", spec])
        .unwrap()
        .trim()
        .to_owned()
}

pub fn branches(git: &Git) -> Vec<String> {
    git.output(&["for-each-ref", "--format=%(refname:short)", "refs/heads"])
        .unwrap()
        .lines()
        .map(str::to_owned)
        .collect()
}

pub fn current_branch(git: &Git) -> Option<String> {
    git.output(&["symbolic-ref", "--short", "-q", "HEAD"])
        .ok()
        .map(|b| b.trim().to_owned())
        .filter(|b| !b.is_empty())
}
