//! Desktop conveniences for the tray and the CLI: open a URL in the default browser, put a
//! link on the clipboard. Through the platform's own tools — no GUI crate for two calls.

use std::process::{Command, Stdio};

pub fn open_url(url: &str) -> Result<(), String> {
    #[cfg(windows)]
    let result = {
        use std::os::windows::process::CommandExt;
        // rundll32 takes the URL verbatim — `cmd /c start` would split it at every `&`.
        Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", url])
            .creation_flags(0x0800_0000)
            .spawn()
    };
    #[cfg(target_os = "macos")]
    let result = Command::new("open").arg(url).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = Command::new("xdg-open")
        .arg(url)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    result.map(|_| ()).map_err(|e| format!("open {url}: {e}"))
}

pub fn copy_text(text: &str) -> Result<(), String> {
    use std::io::Write;
    #[cfg(windows)]
    let candidates: &[(&str, &[&str])] = &[("clip", &[])];
    #[cfg(target_os = "macos")]
    let candidates: &[(&str, &[&str])] = &[("pbcopy", &[])];
    #[cfg(all(unix, not(target_os = "macos")))]
    let candidates: &[(&str, &[&str])] = &[
        ("wl-copy", &[]),
        ("xclip", &["-selection", "clipboard"]),
        ("xsel", &["--clipboard", "--input"]),
    ];
    for (program, args) in candidates {
        let mut command = Command::new(program);
        command
            .args(*args)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }
        let Ok(mut child) = command.spawn() else {
            continue;
        };
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(text.as_bytes());
        }
        if child.wait().map(|s| s.success()).unwrap_or(false) {
            return Ok(());
        }
    }
    Err("no clipboard tool is available".into())
}
