//! Start at login, and come back after a crash (docs/ggs-remote-plan.md §7.12): a Windows
//! scheduled task (logon trigger, restart on failure — a service would run in session 0,
//! without a tray), a macOS LaunchAgent with `KeepAlive`, a Linux XDG autostart entry (plus
//! a systemd user unit example in the README for crash restarts).

use std::path::PathBuf;

pub const TASK_NAME: &str = "GGS Remote";
#[cfg(target_os = "macos")]
const AGENT_LABEL: &str = "dev.ggs.remote";

fn exe() -> Result<PathBuf, String> {
    std::env::current_exe().map_err(|e| format!("locate the daemon executable: {e}"))
}

pub fn apply(enabled: bool) -> Result<(), String> {
    if enabled {
        enable()
    } else {
        disable()
    }
}

#[cfg(windows)]
fn task_xml(exe: &str) -> String {
    let user = std::env::var("USERDOMAIN")
        .ok()
        .zip(std::env::var("USERNAME").ok())
        .map(|(d, u)| format!("{d}\\{u}"))
        .unwrap_or_default();
    let esc = |s: &str| {
        s.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
            .replace('"', "&quot;")
    };
    format!(
        r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>GGS Remote: remote access to Git Graph Studio</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>{user}</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>{user}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author"><Exec><Command>"{exe}"</Command><Arguments>run</Arguments></Exec></Actions>
</Task>
"#,
        user = esc(&user),
        exe = esc(exe)
    )
}

#[cfg(windows)]
fn enable() -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    let exe = exe()?;
    let xml = task_xml(&exe.to_string_lossy());
    let file = std::env::temp_dir().join(format!("ggs-remote-task-{}.xml", std::process::id()));
    // schtasks reads the XML as UTF-16 LE with a BOM.
    let mut bytes = vec![0xFF, 0xFE];
    for unit in xml.encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    std::fs::write(&file, bytes).map_err(|e| e.to_string())?;
    let status = std::process::Command::new("schtasks")
        .args(["/Create", "/TN", TASK_NAME, "/XML"])
        .arg(&file)
        .arg("/F")
        .creation_flags(0x0800_0000)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
    let _ = std::fs::remove_file(&file);
    if status.map(|s| s.success()).unwrap_or(false) {
        return Ok(());
    }
    // Fallback: the per-user Run key (no crash restart, but a login start).
    let value = format!("\"{}\" run", exe.display());
    let ok = std::process::Command::new("reg")
        .args([
            "add",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
            "/v",
            TASK_NAME,
            "/t",
            "REG_SZ",
            "/d",
        ])
        .arg(&value)
        .arg("/f")
        .creation_flags(0x0800_0000)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if ok {
        Ok(())
    } else {
        Err("neither the scheduled task nor the Run key could be written".into())
    }
}

#[cfg(windows)]
fn disable() -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    for args in [
        vec!["schtasks", "/Delete", "/TN", TASK_NAME, "/F"],
        vec![
            "reg",
            "delete",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
            "/v",
            TASK_NAME,
            "/f",
        ],
    ] {
        let _ = std::process::Command::new(args[0])
            .args(&args[1..])
            .creation_flags(0x0800_0000)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn agent_path() -> Result<PathBuf, String> {
    let home = crate::paths::home_dir().ok_or("no home directory")?;
    Ok(home
        .join("Library/LaunchAgents")
        .join(format!("{AGENT_LABEL}.plist")))
}

#[cfg(target_os = "macos")]
fn enable() -> Result<(), String> {
    let exe = exe()?;
    let esc = |s: &str| {
        s.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
    };
    let plist = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{AGENT_LABEL}</string>
  <key>ProgramArguments</key><array><string>{exe}</string><string>run</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
"#,
        exe = esc(&exe.to_string_lossy())
    );
    let path = agent_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, plist).map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
fn disable() -> Result<(), String> {
    let path = agent_path()?;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn desktop_path() -> Result<PathBuf, String> {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| crate::paths::home_dir().map(|h| h.join(".config")))
        .ok_or("no config directory")?;
    Ok(base.join("autostart").join("ggs-remote.desktop"))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn enable() -> Result<(), String> {
    let exe = exe()?;
    let entry = format!(
        "[Desktop Entry]\nType=Application\nName=GGS Remote\nComment=Remote access to Git Graph Studio\nExec=\"{}\" run\nX-GNOME-Autostart-enabled=true\nNoDisplay=true\n",
        exe.display()
    );
    let path = desktop_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, entry).map_err(|e| e.to_string())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn disable() -> Result<(), String> {
    match std::fs::remove_file(desktop_path()?) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(all(test, windows))]
mod tests {
    #[test]
    fn task_xml_escapes_the_path() {
        let xml = super::task_xml(r#"C:\A&B\ggs-remote.exe"#);
        assert!(xml.contains("C:\\A&amp;B\\ggs-remote.exe"));
        assert!(xml.contains("<RestartOnFailure>"));
    }
}
