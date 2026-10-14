//! ggs-testkit (dev-only, beneath every crate's tests): scratch repositories — a
//! temporary directory with a scratch global git config (so "global" writes never touch
//! a developer's own ~/.gitconfig) and the small helpers tests build histories with.
//! A dev-dependency only: nothing here reaches any shipped binary.
//!
//! Allowed dependencies: tempfile — deliberately NOTHING else: a dev-dependency
//! cycle through a domain crate would build two copies of that crate and split every
//! type in two (the git-returning helpers live in each crate's own test code).

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

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

}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

