//! Starting a GGS instance (docs/ggs-remote-plan.md §7.10): the launch spec the latest
//! registered instance reported (`cmd_app::instance_argv` on the app side), or the
//! configured `ggsExe` when none ever registered, plus `--remote-host` for an invisible
//! window and the folder to open.

use crate::config::Config;
use crate::control_msg::LaunchSpec;

/// The program and arguments for a new instance.
pub fn command_line(
    spec: &LaunchSpec,
    folder: Option<&str>,
    visible: bool,
) -> (String, Vec<String>) {
    let mut args = spec.args_prefix.clone();
    if !visible {
        args.push("--remote-host".into());
    }
    if let Some(folder) = folder.filter(|f| !f.is_empty()) {
        args.push(folder.to_owned());
    }
    (spec.program.clone(), args)
}

/// The launch spec to use: the freshest registered one, else the remembered one, else the
/// configured executable.
pub fn pick_spec(live: Option<LaunchSpec>, config: &Config) -> Option<LaunchSpec> {
    live.filter(|s| !s.program.is_empty())
        .or_else(|| config.last_launch.clone().filter(|s| !s.program.is_empty()))
        .or_else(|| {
            config
                .ggs_exe
                .clone()
                .filter(|p| !p.is_empty())
                .map(|program| LaunchSpec {
                    program,
                    args_prefix: Vec::new(),
                })
        })
}

/// Start the instance detached (null stdio, reaped on a spare thread).
pub fn launch(spec: &LaunchSpec, folder: Option<&str>, visible: bool) -> Result<(), String> {
    let (program, args) = command_line(spec, folder, visible);
    let mut command = std::process::Command::new(&program);
    command
        .args(&args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP: the instance outlives the daemon.
        command.creation_flags(0x0000_0008 | 0x0000_0200);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("start {program}: {e}"))?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    crate::info!("spawned an instance (visible: {visible})");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invisible_spawn_adds_the_remote_host_flag_before_the_folder() {
        let spec = LaunchSpec {
            program: "open".into(),
            args_prefix: vec!["-n".into(), "/Applications/GGS.app".into(), "--args".into()],
        };
        let (program, args) = command_line(&spec, Some("/repo"), false);
        assert_eq!(program, "open");
        assert_eq!(
            args,
            vec![
                "-n",
                "/Applications/GGS.app",
                "--args",
                "--remote-host",
                "/repo"
            ]
        );
        let (_, args) = command_line(&spec, None, true);
        assert_eq!(args, vec!["-n", "/Applications/GGS.app", "--args"]);
    }

    #[test]
    fn spec_fallbacks() {
        let mut config = Config::default();
        assert!(pick_spec(None, &config).is_none());
        config.ggs_exe = Some("C:/GGS/ggs.exe".into());
        assert_eq!(pick_spec(None, &config).unwrap().program, "C:/GGS/ggs.exe");
        config.last_launch = Some(LaunchSpec {
            program: "remembered".into(),
            args_prefix: vec![],
        });
        assert_eq!(pick_spec(None, &config).unwrap().program, "remembered");
        let live = LaunchSpec {
            program: "live".into(),
            args_prefix: vec![],
        };
        assert_eq!(pick_spec(Some(live), &config).unwrap().program, "live");
    }
}
