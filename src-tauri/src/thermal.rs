use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, Sender},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

#[cfg(target_os = "linux")]
use std::{fs, path::Path};

use tauri::{AppHandle, Emitter};

use crate::{
    contracts::{ThermalEvent, ThermalState, ThermalStatus},
    job_control::JobControl,
};

const COOL_DWELL: Duration = Duration::from_secs(15);
const POLL_INTERVAL: Duration = Duration::from_secs(1);
#[cfg(target_os = "linux")]
const PAUSE_MARGIN_C: f64 = 15.0;
#[cfg(target_os = "linux")]
const RESUME_MARGIN_C: f64 = 10.0;

#[tauri::command]
pub(super) fn thermal_status() -> ThermalStatus {
    read_status()
}

pub(super) struct JobThermalGuard {
    app: AppHandle,
    job_id: String,
    enabled: bool,
}

impl JobThermalGuard {
    pub(super) fn new(app: AppHandle, job_id: &str, enabled: bool) -> Self {
        Self {
            app,
            job_id: job_id.to_string(),
            enabled,
        }
    }

    pub(super) fn before_child(&self, control: &JobControl) -> Result<(), String> {
        if !self.enabled {
            return Ok(());
        }
        wait_before_child(
            read_status,
            || control.cancel.load(Ordering::SeqCst),
            |state, status| self.emit(state, status),
            POLL_INTERVAL,
            COOL_DWELL,
        )
    }

    pub(super) fn monitor_child(&self, pid: u32, control: &JobControl) -> Option<ThermalMonitor> {
        if !self.enabled || !cfg!(target_os = "linux") {
            return None;
        }
        let app = self.app.clone();
        let job_id = self.job_id.clone();
        Some(start_monitor(
            pid,
            control.cancel.clone(),
            Arc::new(read_status),
            Arc::new(move |state, status| {
                let _ = app.emit(
                    "job:thermal",
                    ThermalEvent {
                        job_id: job_id.clone(),
                        state,
                        status,
                    },
                );
            }),
            POLL_INTERVAL,
            COOL_DWELL,
        ))
    }

    fn emit(&self, state: ThermalState, status: ThermalStatus) {
        let _ = self.app.emit(
            "job:thermal",
            ThermalEvent {
                job_id: self.job_id.clone(),
                state,
                status,
            },
        );
    }
}

pub(super) struct ThermalMonitor {
    stop: Sender<()>,
    thread: Option<JoinHandle<()>>,
}

impl Drop for ThermalMonitor {
    fn drop(&mut self) {
        let _ = self.stop.send(());
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn start_monitor(
    pid: u32,
    cancel: Arc<AtomicBool>,
    read: Arc<dyn Fn() -> ThermalStatus + Send + Sync>,
    emit: Arc<dyn Fn(ThermalState, ThermalStatus) + Send + Sync>,
    poll: Duration,
    dwell: Duration,
) -> ThermalMonitor {
    let (stop, wake) = mpsc::channel();
    let thread = thread::spawn(move || {
        monitor_loop(pid, &wake, &cancel, read, emit, poll, dwell);
    });
    ThermalMonitor {
        stop,
        thread: Some(thread),
    }
}

#[derive(Default)]
struct Cooldown {
    since: Option<Instant>,
}

impl Cooldown {
    fn update(
        &mut self,
        temperature_c: f64,
        resume_at_c: f64,
        now: Instant,
        dwell: Duration,
    ) -> bool {
        if temperature_c > resume_at_c {
            self.since = None;
            return false;
        }
        let since = self.since.get_or_insert(now);
        now.duration_since(*since) >= dwell
    }
}

fn wait_before_child(
    mut read: impl FnMut() -> ThermalStatus,
    cancelled: impl Fn() -> bool,
    mut emit: impl FnMut(ThermalState, ThermalStatus),
    poll: Duration,
    dwell: Duration,
) -> Result<(), String> {
    let mut cooling = false;
    let mut cooldown = Cooldown::default();
    loop {
        if cancelled() {
            return Err("Cancelled".into());
        }
        let status = read();
        if !status.available {
            emit(ThermalState::Unavailable, status);
            return Ok(());
        }
        let temperature = status.temperature_c.unwrap_or(f64::INFINITY);
        if !cooling && temperature < status.pause_at_c.unwrap_or(f64::NEG_INFINITY) {
            emit(ThermalState::Monitoring, status);
            return Ok(());
        }
        cooling = true;
        emit(ThermalState::Cooling, status.clone());
        if temperature <= status.resume_at_c.unwrap_or(f64::NEG_INFINITY) {
            if cooldown.update(
                temperature,
                status.resume_at_c.unwrap_or(f64::NEG_INFINITY),
                Instant::now(),
                dwell,
            ) {
                emit(ThermalState::Monitoring, status);
                return Ok(());
            }
        } else {
            cooldown.update(
                temperature,
                status.resume_at_c.unwrap_or(f64::NEG_INFINITY),
                Instant::now(),
                dwell,
            );
        }
        thread::sleep(poll);
    }
}

fn monitor_loop(
    pid: u32,
    wake: &Receiver<()>,
    cancel: &AtomicBool,
    read: Arc<dyn Fn() -> ThermalStatus + Send + Sync>,
    emit: Arc<dyn Fn(ThermalState, ThermalStatus) + Send + Sync>,
    poll: Duration,
    dwell: Duration,
) {
    let mut paused_group = PausedChildGroup::new(pid);
    let mut cooldown = Cooldown::default();
    loop {
        if cancel.load(Ordering::SeqCst) {
            if paused_group.paused && !paused_group.resume() {
                paused_group.terminate();
            }
            return;
        }
        let mut status = read();
        if !status.available {
            if paused_group.paused && !paused_group.resume() {
                paused_group.terminate();
            }
            cooldown = Cooldown::default();
            emit(ThermalState::Unavailable, status);
        } else if paused_group.paused {
            let temperature = status.temperature_c.unwrap_or(f64::INFINITY);
            if temperature <= status.resume_at_c.unwrap_or(f64::NEG_INFINITY) {
                if cooldown.update(
                    temperature,
                    status.resume_at_c.unwrap_or(f64::NEG_INFINITY),
                    Instant::now(),
                    dwell,
                ) {
                    if paused_group.resume() {
                        cooldown = Cooldown::default();
                        emit(ThermalState::Monitoring, status);
                    } else {
                        status = signal_failure(status, "resume");
                        paused_group.terminate();
                        emit(ThermalState::Unavailable, status);
                        return;
                    }
                } else {
                    emit(ThermalState::Cooling, status);
                }
            } else {
                cooldown.update(
                    temperature,
                    status.resume_at_c.unwrap_or(f64::NEG_INFINITY),
                    Instant::now(),
                    dwell,
                );
                emit(ThermalState::Cooling, status);
            }
        } else if status.temperature_c.unwrap_or(f64::NEG_INFINITY)
            >= status.pause_at_c.unwrap_or(f64::INFINITY)
        {
            if paused_group.pause() {
                cooldown = Cooldown::default();
                emit(ThermalState::Cooling, status);
            } else {
                status = signal_failure(status, "pause");
                emit(ThermalState::Unavailable, status);
            }
        } else {
            emit(ThermalState::Monitoring, status);
        }
        match wake.recv_timeout(poll) {
            Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                if paused_group.paused && !paused_group.resume() {
                    paused_group.terminate();
                }
                return;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
    }
}

struct PausedChildGroup {
    pid: u32,
    paused: bool,
}

impl PausedChildGroup {
    fn new(pid: u32) -> Self {
        Self { pid, paused: false }
    }

    fn pause(&mut self) -> bool {
        if pause_group(self.pid) {
            self.paused = true;
            true
        } else {
            false
        }
    }

    fn resume(&mut self) -> bool {
        if resume_group(self.pid) {
            self.paused = false;
            true
        } else {
            false
        }
    }

    fn terminate(&mut self) {
        terminate_group(self.pid);
        self.paused = false;
    }
}

impl Drop for PausedChildGroup {
    fn drop(&mut self) {
        if self.paused && (thread::panicking() || !resume_group(self.pid)) {
            terminate_group(self.pid);
        }
    }
}

#[cfg(target_os = "linux")]
fn pause_group(pid: u32) -> bool {
    unsafe { libc::kill(-(pid as i32), libc::SIGSTOP) == 0 }
}

#[cfg(not(target_os = "linux"))]
fn pause_group(_pid: u32) -> bool {
    false
}

#[cfg(target_os = "linux")]
fn resume_group(pid: u32) -> bool {
    unsafe { libc::kill(-(pid as i32), libc::SIGCONT) == 0 }
}

#[cfg(not(target_os = "linux"))]
fn resume_group(_pid: u32) -> bool {
    false
}

#[cfg(target_os = "linux")]
fn terminate_group(pid: u32) {
    unsafe {
        libc::kill(-(pid as i32), libc::SIGKILL);
    }
}

#[cfg(not(target_os = "linux"))]
fn terminate_group(_pid: u32) {}

fn signal_failure(mut status: ThermalStatus, action: &str) -> ThermalStatus {
    status.available = false;
    status.reason = Some(format!("Could not {action} the processing child group."));
    status
}

fn unavailable(reason: &str, temperature_c: Option<f64>) -> ThermalStatus {
    ThermalStatus {
        available: false,
        temperature_c,
        pause_at_c: None,
        resume_at_c: None,
        cool_dwell_seconds: COOL_DWELL.as_secs(),
        reason: Some(reason.to_string()),
    }
}

#[cfg(target_os = "linux")]
fn read_status() -> ThermalStatus {
    read_status_at(Path::new("/sys/class/hwmon"), Path::new("/proc/cpuinfo"))
}

#[cfg(not(target_os = "linux"))]
fn read_status() -> ThermalStatus {
    unavailable("CPU thermal monitoring is only supported on Linux.", None)
}

#[cfg(target_os = "linux")]
fn read_status_at(hwmon: &Path, cpuinfo: &Path) -> ThermalStatus {
    let dirs = match fs::read_dir(hwmon) {
        Ok(entries) => entries
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .collect::<Vec<_>>(),
        Err(_) => return unavailable("CPU temperature sensors could not be read.", None),
    };
    let identity = fs::read_to_string(cpuinfo).ok();
    let mut readable_temp = None;
    let mut unavailable_status = None;
    let mut has_package_sensor = false;
    let mut candidates = Vec::new();
    for dir in dirs {
        let Ok(name) = fs::read_to_string(dir.join("name")) else {
            continue;
        };
        match name.trim() {
            "coretemp" => {
                for (temperature, critical, package) in read_coretemp(&dir) {
                    has_package_sensor |= package;
                    readable_temp = Some(
                        readable_temp.map_or(temperature, |current: f64| current.max(temperature)),
                    );
                    let Some(limit) = critical else {
                        unavailable_status = Some(unavailable(
                            "The CPU driver did not expose a verified critical limit.",
                            Some(temperature),
                        ));
                        continue;
                    };
                    let status = available_status(temperature, limit);
                    if status.available {
                        candidates.push((status, package));
                    } else {
                        unavailable_status = Some(status);
                    }
                }
            }
            "k10temp" => {
                if let Some((temperature, critical)) = read_k10temp(&dir) {
                    has_package_sensor = true;
                    readable_temp = Some(
                        readable_temp.map_or(temperature, |current: f64| current.max(temperature)),
                    );
                    let limit_milli = match critical {
                        Ok(Some(limit)) => Some(limit),
                        Ok(None) => identity
                            .as_deref()
                            .filter(|cpuinfo| is_ryzen_5_5500u(cpuinfo))
                            .map(|_| {
                                // AMD Ryzen 5 5500U spec lists 105°C Tjmax: https://www.amd.com/en/support/downloads/drivers.html/processors/ryzen/ryzen-5000-series/amd-ryzen-5-5500u.html
                                105_000
                            }),
                        Err(()) => None,
                    };
                    if let Some(limit_milli) = limit_milli {
                        let status = available_status(temperature, limit_milli as f64 / 1000.0);
                        if status.available {
                            candidates.push((status, true));
                        } else {
                            unavailable_status = Some(status);
                        }
                    }
                }
            }
            _ => {}
        }
    }
    if let Some((status, _)) = candidates
        .into_iter()
        .filter(|(_, package)| !has_package_sensor || *package)
        .min_by(|(left, _), (right, _)| {
            (left.pause_at_c.unwrap() - left.temperature_c.unwrap())
                .total_cmp(&(right.pause_at_c.unwrap() - right.temperature_c.unwrap()))
        })
    {
        return status;
    }
    if let Some(status) = unavailable_status {
        return status;
    }
    unavailable(
        "No supported CPU sensor with a verified thermal limit is available.",
        readable_temp,
    )
}

#[cfg(target_os = "linux")]
fn read_coretemp(dir: &Path) -> Vec<(f64, Option<f64>, bool)> {
    let mut candidates = Vec::new();
    let Ok(entries) = fs::read_dir(dir) else {
        return candidates;
    };
    for entry in entries.filter_map(Result::ok) {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(index) = name
            .strip_prefix("temp")
            .and_then(|name| name.strip_suffix("_input"))
        else {
            continue;
        };
        let Ok(label) = fs::read_to_string(dir.join(format!("temp{index}_label"))) else {
            continue;
        };
        if !label.trim().starts_with("Package id") && !label.trim().starts_with("Core ") {
            continue;
        }
        let Some(temperature) = read_milli_celsius(&entry.path()) else {
            continue;
        };
        let critical = fs::read_to_string(dir.join(format!("temp{index}_crit")))
            .ok()
            .and_then(|value| value.trim().parse::<i64>().ok())
            .map(|value| value as f64 / 1000.0);
        candidates.push((
            temperature,
            critical,
            label.trim().starts_with("Package id"),
        ));
    }
    candidates
}

#[cfg(target_os = "linux")]
fn read_k10temp(dir: &Path) -> Option<(f64, Result<Option<i64>, ()>)> {
    let label = fs::read_to_string(dir.join("temp1_label")).ok()?;
    if label.trim() != "Tctl" {
        return None;
    }
    let temperature = read_milli_celsius(&dir.join("temp1_input"))?;
    let critical = match fs::read_to_string(dir.join("temp1_crit")) {
        Ok(value) => value.trim().parse::<i64>().map(Some).map_err(|_| ()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(()),
    };
    Some((temperature, critical))
}

#[cfg(target_os = "linux")]
fn read_milli_celsius(path: &Path) -> Option<f64> {
    let value = fs::read_to_string(path).ok()?.trim().parse::<i64>().ok()?;
    let celsius = value as f64 / 1000.0;
    (-20.0..=150.0).contains(&celsius).then_some(celsius)
}

#[cfg(target_os = "linux")]
fn available_status(temperature_c: f64, limit_c: f64) -> ThermalStatus {
    let pause = limit_c - PAUSE_MARGIN_C;
    let resume = pause - RESUME_MARGIN_C;
    if !temperature_c.is_finite() || !(40.0..=150.0).contains(&limit_c) || resume <= 0.0 {
        return unavailable(
            "The CPU sensor returned an invalid thermal limit.",
            Some(temperature_c),
        );
    }
    ThermalStatus {
        available: true,
        temperature_c: Some(temperature_c),
        pause_at_c: Some(pause),
        resume_at_c: Some(resume),
        cool_dwell_seconds: COOL_DWELL.as_secs(),
        reason: None,
    }
}

#[cfg(target_os = "linux")]
fn is_ryzen_5_5500u(cpuinfo: &str) -> bool {
    let fields = cpuinfo
        .split("\n\n")
        .next()
        .unwrap_or_default()
        .lines()
        .filter_map(|line| line.split_once(':'))
        .map(|(key, value)| (key.trim(), value.trim()))
        .collect::<std::collections::HashMap<_, _>>();
    fields.get("vendor_id") == Some(&"AuthenticAMD")
        && fields.get("cpu family") == Some(&"23")
        && fields.get("model") == Some(&"104")
        && fields
            .get("model name")
            .is_some_and(|name| name.starts_with("AMD Ryzen 5 5500U"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        sync::atomic::{AtomicBool, Ordering},
        time::Instant,
    };

    #[cfg(target_os = "linux")]
    use std::sync::atomic::AtomicUsize;

    #[cfg(target_os = "linux")]
    use std::{
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };

    fn fake_available_status(temperature_c: f64, limit_c: f64) -> ThermalStatus {
        let pause_at_c = limit_c - 15.0;
        ThermalStatus {
            available: true,
            temperature_c: Some(temperature_c),
            pause_at_c: Some(pause_at_c),
            resume_at_c: Some(pause_at_c - 10.0),
            cool_dwell_seconds: COOL_DWELL.as_secs(),
            reason: None,
        }
    }

    #[cfg(target_os = "linux")]
    fn temp_root() -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "syllen-thermal-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[cfg(target_os = "linux")]
    fn sensor(root: &Path, name: &str, files: &[(&str, &str)]) {
        let dir = root.join(name);
        fs::create_dir_all(&dir).unwrap();
        for (file, value) in files {
            fs::write(dir.join(file), value).unwrap();
        }
    }

    #[cfg(target_os = "linux")]
    struct TestChild {
        control: JobControl,
    }

    #[cfg(target_os = "linux")]
    impl TestChild {
        fn spawn(command: &mut std::process::Command) -> Self {
            let control = JobControl::default();
            *control.child.lock().unwrap() = Some(command.spawn().unwrap());
            Self { control }
        }

        fn pid(&self) -> u32 {
            self.control.child.lock().unwrap().as_ref().unwrap().id()
        }

        fn try_wait(&mut self) -> std::io::Result<Option<std::process::ExitStatus>> {
            self.control
                .child
                .lock()
                .unwrap()
                .as_mut()
                .unwrap()
                .try_wait()
        }

        fn wait(&mut self) -> std::process::ExitStatus {
            self.control
                .child
                .lock()
                .unwrap()
                .take()
                .unwrap()
                .wait()
                .unwrap()
        }
    }

    #[cfg(target_os = "linux")]
    impl Drop for TestChild {
        fn drop(&mut self) {
            crate::process::kill_current(&self.control);
            if let Some(mut child) = self.control.child.lock().unwrap().take() {
                let _ = child.wait();
            }
        }
    }

    #[cfg(target_os = "linux")]
    fn wait_for_stopped(pid: u32, timeout: Duration) -> bool {
        let state_path = format!("/proc/{pid}/stat");
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if fs::read_to_string(&state_path)
                .ok()
                .and_then(|stat| stat.split_whitespace().nth(2).map(str::to_string))
                .as_deref()
                == Some("T")
            {
                return true;
            }
            thread::sleep(Duration::from_millis(5));
        }
        false
    }

    #[cfg(target_os = "linux")]
    fn wait_for_resumed(pid: u32, timeout: Duration) -> bool {
        let state_path = format!("/proc/{pid}/stat");
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if fs::read_to_string(&state_path)
                .ok()
                .and_then(|stat| stat.split_whitespace().nth(2).map(str::to_string))
                .is_some_and(|state| state != "T" && state != "Z" && state != "X")
            {
                return true;
            }
            thread::sleep(Duration::from_millis(5));
        }
        false
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn only_known_cpu_sensor_drivers_and_critical_limits_are_accepted() {
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        sensor(
            &root,
            "hwmon0",
            &[
                ("name", "nvme\n"),
                ("temp1_input", "50000\n"),
                ("temp1_max", "70000\n"),
            ],
        );
        let cpuinfo = root.join("cpuinfo");
        fs::write(&cpuinfo, "").unwrap();
        let status = read_status_at(&root, &cpuinfo);
        assert!(!status.available);
        assert_eq!(status.temperature_c, None);
        fs::remove_dir_all(&root).unwrap();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn coretemp_uses_crit_not_max_and_derives_margins() {
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        sensor(
            &root,
            "hwmon0",
            &[
                ("name", "coretemp\n"),
                ("temp1_label", "Package id 0\n"),
                ("temp1_input", "70000\n"),
                ("temp1_max", "75000\n"),
                ("temp1_crit", "100000\n"),
            ],
        );
        let cpuinfo = root.join("cpuinfo");
        fs::write(&cpuinfo, "").unwrap();
        let status = read_status_at(&root, &cpuinfo);
        assert!(status.available);
        assert_eq!(status.temperature_c, Some(70.0));
        assert_eq!(status.pause_at_c, Some(85.0));
        assert_eq!(status.resume_at_c, Some(75.0));
        fs::remove_dir_all(&root).unwrap();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn coretemp_uses_verified_candidate_when_hottest_package_has_no_limit() {
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        sensor(
            &root,
            "hwmon0",
            &[
                ("name", "coretemp\n"),
                ("temp1_label", "Package id 0\n"),
                ("temp1_input", "99000\n"),
                ("temp2_label", "Package id 1\n"),
                ("temp2_input", "70000\n"),
                ("temp2_crit", "100000\n"),
            ],
        );
        let cpuinfo = root.join("cpuinfo");
        fs::write(&cpuinfo, "").unwrap();

        let status = read_status_at(&root, &cpuinfo);

        assert!(status.available);
        assert_eq!(status.temperature_c, Some(70.0));
        assert_eq!(status.pause_at_c, Some(85.0));
        assert_eq!(status.resume_at_c, Some(75.0));
        fs::remove_dir_all(&root).unwrap();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn coretemp_selects_package_with_least_headroom_and_keeps_its_limit() {
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        sensor(
            &root,
            "hwmon0",
            &[
                ("name", "coretemp\n"),
                ("temp1_label", "Package id 0\n"),
                ("temp1_input", "94000\n"),
                ("temp1_crit", "110000\n"),
                ("temp2_label", "Package id 1\n"),
                ("temp2_input", "92000\n"),
                ("temp2_crit", "100000\n"),
            ],
        );
        let cpuinfo = root.join("cpuinfo");
        fs::write(&cpuinfo, "").unwrap();

        let status = read_status_at(&root, &cpuinfo);

        assert!(status.available);
        assert_eq!(status.temperature_c, Some(92.0));
        assert_eq!(status.pause_at_c, Some(85.0));
        assert_eq!(status.resume_at_c, Some(75.0));
        fs::remove_dir_all(&root).unwrap();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn k10temp_uses_the_exact_verified_5500u_fallback_only() {
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        sensor(
            &root,
            "hwmon0",
            &[
                ("name", "k10temp\n"),
                ("temp1_label", "Tctl\n"),
                ("temp1_input", "99000\n"),
            ],
        );
        let cpuinfo = root.join("cpuinfo");
        fs::write(
            &cpuinfo,
            "vendor_id : AuthenticAMD\ncpu family : 23\nmodel : 104\nmodel name : AMD Ryzen 5 5500U with Radeon Graphics\n\n",
        )
        .unwrap();
        let status = read_status_at(&root, &cpuinfo);
        assert!(status.available);
        assert_eq!(status.pause_at_c, Some(90.0));
        assert_eq!(status.resume_at_c, Some(80.0));
        fs::write(root.join("hwmon0/temp1_crit"), "98000\n").unwrap();
        let status = read_status_at(&root, &cpuinfo);
        assert_eq!(status.pause_at_c, Some(83.0));
        assert_eq!(status.resume_at_c, Some(73.0));
        fs::remove_file(root.join("hwmon0/temp1_crit")).unwrap();
        fs::write(
            &cpuinfo,
            "vendor_id : AuthenticAMD\ncpu family : 23\nmodel : 104\nmodel name : Other CPU\n\n",
        )
        .unwrap();
        let status = read_status_at(&root, &cpuinfo);
        assert!(!status.available);
        assert_eq!(status.temperature_c, Some(99.0));
        fs::remove_dir_all(&root).unwrap();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn malformed_sensor_values_are_explicitly_unavailable() {
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        sensor(
            &root,
            "hwmon0",
            &[
                ("name", "k10temp\n"),
                ("temp1_label", "Tctl\n"),
                ("temp1_input", "not-a-number\n"),
            ],
        );
        let cpuinfo = root.join("cpuinfo");
        fs::write(&cpuinfo, "").unwrap();
        assert!(!read_status_at(&root, &cpuinfo).available);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn cancellation_interrupts_the_hot_wait() {
        let cancelled = AtomicBool::new(false);
        let mut saw_cooling = false;
        let result = wait_before_child(
            || fake_available_status(91.0, 105.0),
            || cancelled.load(Ordering::SeqCst),
            |state, _| {
                if matches!(state, ThermalState::Cooling) {
                    saw_cooling = true;
                    cancelled.store(true, Ordering::SeqCst);
                }
            },
            Duration::from_millis(1),
            Duration::from_millis(30),
        );
        assert_eq!(result, Err("Cancelled".into()));
        assert!(saw_cooling);
    }

    #[cfg(not(target_os = "linux"))]
    #[test]
    fn thermal_status_is_unavailable_off_linux() {
        let status = read_status();
        assert!(!status.available);
        assert_eq!(status.temperature_c, None);
        assert!(
            status
                .reason
                .as_deref()
                .unwrap()
                .contains("only supported on Linux")
        );
    }

    #[test]
    fn cooldown_clock_resets_when_temperature_rises_above_resume_limit() {
        let start = Instant::now();
        let dwell = Duration::from_secs(15);
        let mut cooldown = Cooldown::default();
        assert!(!cooldown.update(79.0, 80.0, start, dwell));
        assert!(!cooldown.update(79.0, 80.0, start + Duration::from_secs(14), dwell));
        assert!(!cooldown.update(80.1, 80.0, start + Duration::from_secs(14), dwell));
        assert!(!cooldown.update(79.0, 80.0, start + Duration::from_secs(14), dwell));
        assert!(cooldown.update(79.0, 80.0, start + Duration::from_secs(29), dwell));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn monitor_panic_after_stopping_child_terminates_its_group() {
        use std::os::unix::process::CommandExt;

        let mut command = std::process::Command::new("sh");
        command.args(["-c", "exec sleep 30"]).process_group(0);
        let mut child = TestChild::spawn(&mut command);
        let pid = child.pid();
        let monitor = start_monitor(
            pid,
            Arc::new(AtomicBool::new(false)),
            Arc::new(|| fake_available_status(91.0, 105.0)),
            Arc::new(move |state, _| {
                if matches!(state, ThermalState::Cooling) {
                    assert!(wait_for_stopped(pid, Duration::from_secs(1)));
                    panic!("injected monitor panic after SIGSTOP");
                }
            }),
            Duration::from_millis(5),
            Duration::from_millis(30),
        );

        drop(monitor);
        let deadline = Instant::now() + Duration::from_secs(1);
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break status;
            }
            assert!(
                Instant::now() < deadline,
                "child remained stopped after monitor panic"
            );
            thread::sleep(Duration::from_millis(5));
        };
        assert!(!status.success());
        assert!(!child.wait().success());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn monitor_stops_and_resumes_only_its_harmless_child_group() {
        use std::os::unix::process::CommandExt;

        let mut command = std::process::Command::new("sh");
        command.args(["-c", "exec sleep 30"]).process_group(0);
        let mut child = command.spawn().unwrap();
        let pid = child.id();
        let hot = Arc::new(AtomicBool::new(true));
        let reader_state = hot.clone();
        let reader = Arc::new(move || {
            if reader_state.load(Ordering::SeqCst) {
                fake_available_status(91.0, 105.0)
            } else {
                fake_available_status(79.0, 105.0)
            }
        });
        let monitor = start_monitor(
            pid,
            Arc::new(AtomicBool::new(false)),
            reader,
            Arc::new(|_, _| {}),
            Duration::from_millis(10),
            Duration::from_millis(30),
        );
        let state_path = format!("/proc/{pid}/stat");
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            let stat = fs::read_to_string(&state_path).unwrap();
            if stat.split_whitespace().nth(2) == Some("T") {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(
            fs::read_to_string(&state_path)
                .unwrap()
                .split_whitespace()
                .nth(2),
            Some("T")
        );
        hot.store(false, Ordering::SeqCst);
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if fs::read_to_string(&state_path)
                .ok()
                .and_then(|stat| stat.split_whitespace().nth(2).map(str::to_string))
                .is_some_and(|state| state != "T")
            {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        assert!(
            fs::read_to_string(&state_path)
                .unwrap()
                .split_whitespace()
                .nth(2)
                != Some("T")
        );
        drop(monitor);
        unsafe { libc::kill(-(pid as i32), libc::SIGKILL) };
        let _ = child.wait();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn monitor_resumes_a_paused_child_when_the_sensor_disappears() {
        use std::{os::unix::process::CommandExt, sync::Mutex};

        let mut command = std::process::Command::new("sh");
        command.args(["-c", "exec sleep 30"]).process_group(0);
        let mut child = command.spawn().unwrap();
        let pid = child.id();
        let reads = Arc::new(AtomicUsize::new(0));
        let reader_reads = reads.clone();
        let reader = Arc::new(move || {
            if reader_reads.fetch_add(1, Ordering::SeqCst) == 0 {
                fake_available_status(91.0, 105.0)
            } else {
                unavailable("sensor disappeared", Some(91.0))
            }
        });
        let states = Arc::new(Mutex::new(Vec::new()));
        let event_states = states.clone();
        let monitor = start_monitor(
            pid,
            Arc::new(AtomicBool::new(false)),
            reader,
            Arc::new(move |state, _| event_states.lock().unwrap().push(state)),
            Duration::from_millis(10),
            Duration::from_millis(30),
        );
        let state_path = format!("/proc/{pid}/stat");
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if fs::read_to_string(&state_path)
                .ok()
                .and_then(|stat| stat.split_whitespace().nth(2).map(str::to_string))
                .is_some_and(|state| state != "T")
                && reads.load(Ordering::SeqCst) > 1
            {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        assert!(
            fs::read_to_string(&state_path)
                .unwrap()
                .split_whitespace()
                .nth(2)
                != Some("T")
        );
        assert!(states.lock().unwrap().contains(&ThermalState::Unavailable));
        drop(monitor);
        unsafe { libc::kill(-(pid as i32), libc::SIGKILL) };
        let _ = child.wait();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn monitor_drop_interrupts_the_full_poll_interval() {
        use std::os::unix::process::CommandExt;

        let mut command = std::process::Command::new("sh");
        command.args(["-c", "exec sleep 30"]).process_group(0);
        let mut child = command.spawn().unwrap();
        let pid = child.id();
        let samples = Arc::new(AtomicUsize::new(0));
        let reader_samples = samples.clone();
        let monitor = start_monitor(
            pid,
            Arc::new(AtomicBool::new(false)),
            Arc::new(move || {
                reader_samples.fetch_add(1, Ordering::SeqCst);
                fake_available_status(45.0, 105.0)
            }),
            Arc::new(|_, _| {}),
            Duration::from_secs(1),
            Duration::from_secs(15),
        );
        let deadline = Instant::now() + Duration::from_secs(1);
        while samples.load(Ordering::SeqCst) == 0 && Instant::now() < deadline {
            thread::yield_now();
        }
        assert!(samples.load(Ordering::SeqCst) > 0);
        let started = Instant::now();
        drop(monitor);
        assert!(started.elapsed() < Duration::from_millis(300));
        unsafe { libc::kill(-(pid as i32), libc::SIGKILL) };
        let _ = child.wait();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn dropping_a_paused_monitor_resumes_its_child_group() {
        use std::os::unix::process::CommandExt;

        let mut command = std::process::Command::new("sh");
        command.args(["-c", "exec sleep 30"]).process_group(0);
        let mut child = command.spawn().unwrap();
        let pid = child.id();
        let monitor = start_monitor(
            pid,
            Arc::new(AtomicBool::new(false)),
            Arc::new(|| fake_available_status(91.0, 105.0)),
            Arc::new(|_, _| {}),
            Duration::from_secs(1),
            Duration::from_secs(15),
        );
        let state_path = format!("/proc/{pid}/stat");
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if fs::read_to_string(&state_path)
                .ok()
                .and_then(|stat| stat.split_whitespace().nth(2).map(str::to_string))
                .is_some_and(|state| state == "T")
            {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(
            fs::read_to_string(&state_path)
                .unwrap()
                .split_whitespace()
                .nth(2),
            Some("T")
        );
        drop(monitor);
        assert_ne!(
            fs::read_to_string(&state_path)
                .unwrap()
                .split_whitespace()
                .nth(2),
            Some("T")
        );
        unsafe { libc::kill(-(pid as i32), libc::SIGKILL) };
        let _ = child.wait();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn monitor_cancel_resumes_paused_child_before_monitor_drop() {
        use std::os::unix::process::CommandExt;

        let mut command = std::process::Command::new("sh");
        command.args(["-c", "exec sleep 2"]).process_group(0);
        let child = TestChild::spawn(&mut command);
        let pid = child.pid();
        let cancel = child.control.cancel.clone();
        let monitor = start_monitor(
            pid,
            cancel.clone(),
            Arc::new(|| fake_available_status(91.0, 105.0)),
            Arc::new(|_, _| {}),
            Duration::from_millis(10),
            Duration::from_millis(30),
        );

        assert!(wait_for_stopped(pid, Duration::from_secs(2)));
        cancel.store(true, Ordering::SeqCst);
        assert!(
            wait_for_resumed(pid, Duration::from_secs(1)),
            "monitor cancel did not resume the child before monitor drop"
        );
        drop(monitor);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn production_cancel_kills_paused_child_group_and_monitor_joins() {
        use std::os::unix::process::CommandExt;

        let mut command = std::process::Command::new("sh");
        command.args(["-c", "exec sleep 30"]).process_group(0);
        let mut child = TestChild::spawn(&mut command);
        let pid = child.pid();
        let cancel = child.control.cancel.clone();
        let monitor = start_monitor(
            pid,
            cancel.clone(),
            Arc::new(|| fake_available_status(91.0, 105.0)),
            Arc::new(|_, _| {}),
            Duration::from_secs(1),
            Duration::from_secs(15),
        );
        assert!(wait_for_stopped(pid, Duration::from_secs(2)));
        cancel.store(true, Ordering::SeqCst);
        crate::process::kill_current(&child.control);
        drop(monitor);
        let deadline = Instant::now() + Duration::from_secs(1);
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break status;
            }
            assert!(
                Instant::now() < deadline,
                "cancelled child group remained alive"
            );
            thread::sleep(Duration::from_millis(5));
        };
        assert!(!status.success());
        assert!(!child.wait().success());
    }
}
