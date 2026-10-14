//! The git-returning scratch helpers for the byte services' tests — the same extension
//! ggs-git's own tests carry (its `testkit_ext`) and the app's `test_git_helpers`;
//! duplicated per crate because the helpers cannot live in ggs-testkit (a
//! dev-dependency cycle would build two copies of a domain crate).

use std::fs;
use std::path::Path;

use ggs_testkit::Scratch;

use ggs_git::runner::Git;

pub trait ScratchGit {
    fn git(&self, repo: &std::path::Path) -> Git;
    fn repo(&self, name: &str) -> Git;
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
