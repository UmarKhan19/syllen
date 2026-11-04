use std::{
    io::{BufRead, BufReader},
    path::Path,
    process::{Child, Command, ExitStatus, Stdio},
    sync::{Arc, Mutex},
};

use crate::job_control::JobControl;
use crate::thermal::{JobThermalGuard, ThermalMonitor};

pub(super) fn tail(lines: &[String]) -> String {
    let start = lines.len().saturating_sub(12);
    lines[start..].join("\n").trim().to_string()
}

pub(super) fn configure(cmd: &mut Command) {
    cmd.stdin(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
        #[cfg(target_os = "linux")]
        let parent_pid = std::process::id() as i32;
        unsafe {
            cmd.pre_exec(move || {
                #[cfg(target_os = "linux")]
                {
                    if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                    if libc::getppid() != parent_pid {
                        return Err(std::io::Error::from_raw_os_error(libc::EINTR));
                    }
                }
                let current = libc::getpriority(libc::PRIO_PROCESS, 0);
                let target = current.max(10);
                if libc::setpriority(libc::PRIO_PROCESS, 0, target) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000 | 0x0000_4000);
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::configure;
    use std::process::Command;

    #[test]
    fn child_priority_is_lowered_without_changing_parent() {
        let parent = unsafe { libc::getpriority(libc::PRIO_PROCESS, 0) };
        let mut command = Command::new("sh");
        command.args(["-c", "ps -o ni= -p $$"]);
        configure(&mut command);
        let output = command.output().unwrap();
        assert!(output.status.success());
        let child: i32 = String::from_utf8_lossy(&output.stdout)
            .trim()
            .parse()
            .unwrap();
        assert!(child >= 10, "child niceness was {child}");
        assert_eq!(unsafe { libc::getpriority(libc::PRIO_PROCESS, 0) }, parent);
    }
}

pub(super) fn spawn_error(program: &Path, error: std::io::Error) -> String {
    if error.kind() == std::io::ErrorKind::NotFound {
        format!(
            "{} not found. Install it, or bundle it in the app's resources/bin folder.",
            program.display()
        )
    } else {
        format!("Could not run {}: {error}", program.display())
    }
}

pub(super) fn kill_tree(child: &mut Child) {
    #[cfg(unix)]
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .creation_flags(0x0800_0000)
            .status();
    }
    let _ = child.kill();
}

pub(super) fn kill_current(control: &JobControl) {
    if let Some(child) = control.child.lock().unwrap().as_mut() {
        kill_tree(child);
    }
}

pub(super) fn run_capture(cmd: &mut Command) -> Result<(String, String, ExitStatus), String> {
    configure(cmd);
    let output = cmd
        .output()
        .map_err(|e| spawn_error(cmd.get_program().as_ref(), e))?;
    Ok((
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
        output.status,
    ))
}

pub(super) fn run_streaming(
    cmd: &mut Command,
    control: &JobControl,
    thermal_guard: &JobThermalGuard,
    on_line: &mut dyn FnMut(&str),
) -> Result<(ExitStatus, Vec<String>), String> {
    thermal_guard.before_child(control)?;
    configure(cmd);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| spawn_error(cmd.get_program().as_ref(), e))?;
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            kill_tree(&mut child);
            return Err("Could not read process output".into());
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            kill_tree(&mut child);
            return Err("Could not read process output".into());
        }
    };
    let pid = child.id();
    *control.child.lock().unwrap() = Some(child);
    if control.cancel.load(std::sync::atomic::Ordering::SeqCst) {
        kill_current(control);
    }
    let monitor: Option<ThermalMonitor> = thermal_guard.monitor_child(pid, control);

    let err_lines = Arc::new(Mutex::new(Vec::<String>::new()));
    let err_sink = err_lines.clone();
    let err_thread = std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            let mut lines = err_sink.lock().unwrap();
            if lines.len() < 200 {
                lines.push(line);
            }
        }
    });

    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        on_line(&line);
    }

    drop(monitor);

    let status = {
        let child = control.child.lock().unwrap().take();
        match child {
            Some(mut c) => match c.wait() {
                Ok(status) => status,
                Err(error) => {
                    kill_tree(&mut c);
                    return Err(format!("Waiting for process failed: {error}"));
                }
            },
            None => return Err("The process disappeared while running".into()),
        }
    };
    let _ = err_thread.join();
    let lines = err_lines.lock().unwrap().clone();
    Ok((status, lines))
}
