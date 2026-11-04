//! The interactive session's command history, persisted across runs — the file
//! `$HISTFILE` names, or `~/.ggs/bash_history` (the app's own, never Git Bash's
//! `~/.bash_history` — the two shells stay out of each other's files). Loaded once
//! at the REPL's start, appended on its exit; a hard kill loses only the lines
//! typed after the last save.

use std::path::PathBuf;

use crate::exec::Shell;

/// How many lines a save keeps in the file, the oldest dropped — bash's own
/// HISTSIZE habit, and the bound that keeps a decades-old file from growing
/// without end.
const HISTORY_LINES: usize = 1000;

/// The file the session's history rides: `$HISTFILE` when one is set, else
/// `~/.ggs/bash_history`. `None` where no home is known — a historyless session,
/// not an error.
pub fn history_path(shell: &Shell) -> Option<PathBuf> {
    if let Some(named) = shell.get_var("HISTFILE") {
        if !named.trim().is_empty() {
            return Some(shell.resolve_working_path(&named));
        }
    }
    let home = shell.get_var("HOME")?;
    if home.trim().is_empty() {
        return None;
    }
    Some(shell.resolve_working_path(&format!("{home}/.ggs/bash_history")))
}

/// Read the file into the shell's history (newest last) and answer how many lines
/// the load contributed — the mark the exit's [`save`] appends past. A missing or
/// unreadable file is an empty history; the REPL must start whatever happened.
pub fn load(shell: &mut Shell) -> usize {
    let Some(path) = history_path(shell) else {
        return 0;
    };
    let Ok(text) = std::fs::read_to_string(&path) else {
        return 0;
    };
    let lines: Vec<String> = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| line.to_owned())
        .collect();
    let kept = lines.len().saturating_sub(HISTORY_LINES);
    shell.history.extend(lines[kept..].iter().cloned());
    shell.history.len()
}

/// Append the session's own lines (those past `loaded`) to the file — consecutive
/// duplicates dropped, the file trimmed to [`HISTORY_LINES`] lines. A write failure
/// is quiet: the session ran fine, only its history is lost.
pub fn save(shell: &Shell, loaded: usize) {
    let Some(path) = history_path(shell) else {
        return;
    };
    let mut lines: Vec<String> = std::fs::read_to_string(&path)
        .map(|text| text.lines().map(|line| line.to_owned()).collect())
        .unwrap_or_default();
    let fresh = loaded.min(shell.history.len());
    for line in &shell.history[fresh..] {
        if lines.last().map(|last| last == line).unwrap_or(false) {
            continue;
        }
        lines.push(line.clone());
    }
    if lines.len() > HISTORY_LINES {
        lines = lines.split_off(lines.len() - HISTORY_LINES);
    }
    if lines.is_empty() {
        return;
    }
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let mut body = lines.join("\n");
    body.push('\n');
    let _ = std::fs::write(&path, body);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exec::Shell;

    fn shell_with(vars: &[(&str, &str)]) -> Shell {
        let mut shell = Shell::new("ggs-bash");
        for (name, value) in vars {
            shell.set_var(name, value);
        }
        shell
    }

    #[test]
    fn the_history_file_is_the_homes_ggs_history_unless_histfile_names_one() {
        let home_dir = tempfile::TempDir::new().unwrap();
        let home = home_dir.path().to_str().unwrap().to_owned();
        let default = history_path(&shell_with(&[("HOME", &home)])).unwrap();
        assert!(default.ends_with(".ggs/bash_history"), "{default:?}");
        // The user's own HISTFILE wins; an empty one reads as unset — the default answers.
        let named_dir = tempfile::TempDir::new().unwrap();
        let named = named_dir.path().join("my-hist");
        let path = history_path(&shell_with(&[("HOME", &home), ("HISTFILE", named.to_str().unwrap())])).unwrap();
        assert_eq!(path, named);
        assert_eq!(history_path(&shell_with(&[("HOME", &home), ("HISTFILE", "")])), Some(default));
        // No home at all — a historyless session, not an error.
        assert_eq!(history_path(&shell_with(&[("HOME", "")])), None);
    }

    #[test]
    fn a_session_appends_its_lines_past_the_loaded_mark_and_dedupes_the_run() {
        let home_dir = tempfile::TempDir::new().unwrap();
        let home = home_dir.path().to_str().unwrap().to_owned();
        let dir = home_dir.path().join(".ggs");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("bash_history"), "echo a\necho b\n").unwrap();
        let mut shell = shell_with(&[("HOME", &home)]);
        let loaded = load(&mut shell);
        assert_eq!(loaded, 2);
        assert_eq!(shell.history, ["echo a", "echo b"]);
        // The session repeats the file's last line and adds new ones: the repeat
        // dedupes away (it is the file's own last line already), the new ones land.
        shell.history.push("echo b".to_owned());
        shell.history.push("echo c".to_owned());
        shell.history.push("echo c".to_owned());
        save(&shell, loaded);
        let text = std::fs::read_to_string(dir.join("bash_history")).unwrap();
        assert_eq!(text, "echo a\necho b\necho c\n");
        // The next session loads the lot; its own save adds nothing new — the file
        // is untouched.
        let mut next = shell_with(&[("HOME", &home)]);
        assert_eq!(load(&mut next), 3);
        save(&next, 3);
        let again = std::fs::read_to_string(dir.join("bash_history")).unwrap();
        assert_eq!(again, text);
    }

    #[test]
    fn a_missing_file_is_an_empty_history_and_a_save_still_lands() {
        let home = tempfile::TempDir::new().unwrap();
        let mut shell = shell_with(&[("HOME", home.path().to_str().unwrap())]);
        assert_eq!(load(&mut shell), 0);
        shell.history.push("echo first".to_owned());
        save(&shell, 0);
        let text = std::fs::read_to_string(home.path().join(".ggs/bash_history")).unwrap();
        assert_eq!(text, "echo first\n");
    }

    #[test]
    fn the_file_is_capped_at_history_lines() {
        let home = tempfile::TempDir::new().unwrap();
        let mut shell = shell_with(&[("HOME", home.path().to_str().unwrap())]);
        for i in 0..(HISTORY_LINES + 200) {
            shell.history.push(format!("cmd-{i}"));
        }
        save(&shell, 0);
        let text = std::fs::read_to_string(home.path().join(".ggs/bash_history")).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), HISTORY_LINES);
        assert_eq!(lines.first().copied(), Some("cmd-200"));
        assert_eq!(lines.last().copied(), Some(format!("cmd-{}", HISTORY_LINES + 199).as_str()));
    }
}
