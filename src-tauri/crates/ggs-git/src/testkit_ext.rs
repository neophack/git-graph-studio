//! The git-returning scratch helpers as a test-only extension of ggs_testkit's
//! Scratch — testkit itself stays dep-free (a dev-dependency cycle would build TWO
//! copies of this crate and split every type in two; the helpers live here instead).

#![cfg(test)]

use std::fs;
use std::path::{Path, PathBuf};

use ggs_testkit::Scratch;

use crate::runner::Git;

pub trait ScratchGit {
    fn git(&self, repo: &std::path::Path) -> Git;
    fn repo(&self, name: &str) -> Git;
    fn bare(&self, name: &str) -> PathBuf;
}

impl ScratchGit for Scratch {
    fn git(&self, repo: &Path) -> Git {
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
    fn repo(&self, name: &str) -> Git {
        let path = self.path(name);
        fs::create_dir_all(&path).unwrap();
        let git = self.git(&path);
        git.run(&["init", "-q", "-b", "main"]).unwrap();
        commit(&git, "README.md", "hello\n", "Initial commit");
        git
    }


    /// A bare repository, used as a remote.
    fn bare(&self, name: &str) -> PathBuf {
        let path = self.path(name);
        fs::create_dir_all(&path).unwrap();
        self.git(&path)
            .run(&["init", "-q", "--bare", "-b", "main"])
            .unwrap();
        path
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



pub fn scratch_current_branch(git: &Git) -> Option<String> {
    git.output(&["symbolic-ref", "--short", "-q", "HEAD"])
        .ok()
        .map(|b| b.trim().to_owned())
        .filter(|b| !b.is_empty())
}

