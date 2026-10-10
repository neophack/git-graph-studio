//! The ggs-bash binary's CLI contract (module 18), asserted against the real built
//! binary — the layer the in-process `run_in` seam cannot reach. Harnesses invoke the
//! shell with the login/interactive flags riding around `-c` in every order
//! (`ggs-bash -c -l pwd` must run `pwd`; a harness's Bash tool once got
//! `-l: command not found`, the fix pinned by these tests), and the words after the
//! command string are positional parameters.

use std::io::Write;
use std::process::{Command, Output, Stdio};

// The N-API host's exported surface must be in this image for the /EXPORT directives
// to resolve; this suite never loads an addon itself, so this test holds the reference
// the linker needs (a const cannot — it folds away).
#[test]
#[cfg(feature = "node-runtime")]
fn the_napi_surface_links() {
    git_graph_studio_lib::node_runtime::link_napi_host();
}

fn ggs_bash(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_ggs-bash"))
        .args(args)
        .output()
        .expect("the ggs-bash binary runs")
}

fn stdout(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).into_owned()
}

#[test]
fn login_and_interactive_flags_ride_around_c_in_any_order() {
    for argv in [
        ["-l", "-c", "echo cli-ok"].as_slice(),
        ["-c", "-l", "echo cli-ok"].as_slice(),
        ["-lc", "echo cli-ok"].as_slice(),
        ["-ilc", "echo cli-ok"].as_slice(),
        ["-c", "-i", "-l", "echo cli-ok"].as_slice(),
        ["--login", "-c", "echo cli-ok"].as_slice(),
        ["-c", "--", "echo cli-ok"].as_slice(),
    ] {
        let output = ggs_bash(argv);
        assert!(
            output.status.success(),
            "{argv:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(stdout(&output), "cli-ok\n", "{argv:?}");
    }
}

#[test]
fn words_after_the_command_string_are_positional() {
    let output = ggs_bash(&["-c", "echo \"$0|$1|$#|$@\"", "-i", "AA", "BB"]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(stdout(&output), "-i|AA|2|AA BB\n");
}

#[test]
fn a_script_file_takes_its_arguments_dashes_and_all() {
    let dir = tempfile::TempDir::new().unwrap();
    let script = dir.path().join("s.sh");
    std::fs::write(&script, "echo \"$0|$1|$2\"\n").unwrap();
    let path = script.to_str().unwrap();
    let output = ggs_bash(&[path, "-x", "val"]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(stdout(&output), format!("{path}|-x|val\n"));
}

#[test]
fn an_unknown_option_is_an_error_not_a_command() {
    let output = ggs_bash(&["-Z", "-c", "echo hi"]);
    assert_eq!(output.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&output.stderr).contains("-Z"));
}

#[test]
fn a_piped_script_runs_under_the_login_flag() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_ggs-bash"))
        .args(["-l"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("the ggs-bash binary spawns");
    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(b"echo pipe-ok\n")
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(stdout(&output), "pipe-ok\n");
}
