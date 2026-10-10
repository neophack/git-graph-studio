//! Git Bash's path dialect (module 18): MSYS addresses the Windows world through a
//! virtual root — `/c/Users/...` for drives, `/tmp`, `/dev/null` — and presents `PATH`
//! colon-separated. Users and AI assistants write commands in that dialect, so the
//! shell speaks it on both directions: every path it resolves accepts the MSYS form
//! ([`from_msys`]) and every absolute path it prints uses it ([`to_msys`]). Forward
//! slashes after the drive survive everywhere — Windows APIs take them.

use std::path::Path;

/// `C:\Users\x` (or `C:/Users/x`) → `/c/Users/x`. Relative paths come back unchanged
/// pieces (the caller keeps the shape it was given).
pub fn to_msys(path: &Path) -> String {
    // A canonicalized Windows path carries the verbatim prefix: `\\?\C:\x` is `C:\x`.
    let text = path.display().to_string();
    let text = text.strip_prefix("\\\\?\\").unwrap_or(&text);
    if let Some((drive, tail)) = strip_drive(text) {
        let tail = tail.trim_start_matches(['/', '\\']).replace('\\', "/");
        return format!("/{}/{}", drive.to_ascii_lowercase(), tail);
    }
    text.replace('\\', "/")
}

/// `/c/Users/x` → `C:/Users/x`; `/tmp/...` → the user's temp dir; `/dev/null` → `NUL`.
/// Anything that is not the MSYS shape (already-Windows paths, relative paths) returns
/// unchanged — this is a translator, not an enforcer.
pub fn from_msys(text: &str) -> String {
    if text == "/dev/null" {
        return "NUL".to_owned();
    }
    if text == "/tmp" || text.starts_with("/tmp/") {
        let temp = std::env::temp_dir()
            .display()
            .to_string()
            .replace('\\', "/");
        return format!("{}{}", temp.trim_end_matches(['/', '\\']), &text[4..]);
    }
    // `/c/…` or a bare `/c` — one letter, then a separator or the end.
    let bytes = text.as_bytes();
    if bytes.first() == Some(&b'/') && bytes.len() >= 2 && bytes[1].is_ascii_alphabetic() {
        let after = &text[2..];
        if after.is_empty() || after.starts_with('/') {
            let drive = text[1..2].to_ascii_uppercase();
            return format!("{drive}:{}", after.replace('\\', "/"));
        }
    }
    text.to_owned()
}

/// One command argument for an external program: MSYS absolute paths cross over
/// (whole token, or the value after `=`), exactly the way MSYS2 converts arguments for
/// native executables — but only the unambiguous single-letter-drive shape, so
/// `/api/endpoint` style flags and URLs stay untouched.
pub fn translate_argument(arg: &str) -> String {
    if let Some((name, value)) = arg.split_once('=') {
        if is_msys_shape(value) || value == "/dev/null" || value.starts_with("/tmp/") {
            return format!("{name}={}", from_msys(value));
        }
        return arg.to_owned();
    }
    if is_msys_shape(arg) || arg == "/dev/null" || arg.starts_with("/tmp/") || arg == "/tmp" {
        return from_msys(arg);
    }
    arg.to_owned()
}

/// The unambiguous MSYS absolute shape: `/` + one drive letter + (`/` or the end).
pub fn is_msys_shape(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.first() == Some(&b'/')
        && bytes.len() >= 2
        && bytes[1].is_ascii_alphabetic()
        && (bytes.len() == 2 || bytes[2] == b'/')
}

/// The MSYS spelling of `HOME` for the prompt: `/c/Users/x`, with `~` for home itself.
pub fn display_cwd(cwd: &Path, home: Option<&str>) -> String {
    let msys = to_msys(cwd);
    match home {
        Some(home) if !home.is_empty() => {
            let home_msys = to_msys(Path::new(home));
            if msys == home_msys {
                "~".to_owned()
            } else if let Some(rest) = msys.strip_prefix(&format!("{home_msys}/")) {
                format!("~/{rest}")
            } else {
                msys
            }
        }
        _ => msys,
    }
}

fn strip_drive(text: &str) -> Option<(String, &str)> {
    let bytes = text.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
        return Some((text[..1].to_owned(), &text[2..]));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drive_paths_translate_both_ways() {
        assert_eq!(from_msys("/c/Users/fred"), "C:/Users/fred");
        assert_eq!(from_msys("/d"), "D:");
        assert_eq!(from_msys("C:/already/windows"), "C:/already/windows");
        assert_eq!(from_msys("relative/path"), "relative/path");
        assert_eq!(to_msys(Path::new("C:\\Users\\fred")), "/c/Users/fred");
        assert_eq!(to_msys(Path::new("C:/Users/fred")), "/c/Users/fred");
        assert_eq!(to_msys(Path::new("just/relative")), "just/relative");
    }

    #[test]
    fn the_special_files_map_to_windows_equivalents() {
        assert_eq!(from_msys("/dev/null"), "NUL");
        let tmp = from_msys("/tmp/build.log");
        let temp = std::env::temp_dir()
            .display()
            .to_string()
            .replace('\\', "/");
        assert!(tmp.starts_with(temp.trim_end_matches('/')), "{tmp}");
        assert!(tmp.ends_with("/build.log"));
    }

    #[test]
    fn arguments_translate_only_the_unambiguous_shapes() {
        assert_eq!(
            translate_argument("/c/Program Files/git/cmd"),
            "C:/Program Files/git/cmd"
        );
        assert_eq!(translate_argument("PATH=/c/tools/bin"), "PATH=C:/tools/bin");
        // Not one-letter drives: untouched (a URL path, a flag's value).
        assert_eq!(translate_argument("/api/v1/users"), "/api/v1/users");
        assert_eq!(
            translate_argument("--prefix=/usr/local"),
            "--prefix=/usr/local"
        );
        assert_eq!(translate_argument("plain.txt"), "plain.txt");
    }

    #[test]
    fn the_prompt_shortens_home_to_a_tilde() {
        let home = "C:/Users/fred";
        assert_eq!(display_cwd(Path::new("C:/Users/fred"), Some(home)), "~");
        assert_eq!(
            display_cwd(Path::new("C:/Users/fred/src"), Some(home)),
            "~/src"
        );
        assert_eq!(
            display_cwd(Path::new("D:/elsewhere"), Some(home)),
            "/d/elsewhere"
        );
    }
}
