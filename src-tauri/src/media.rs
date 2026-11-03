//! Saves streams (HLS, DASH) by running yt-dlp and ffmpeg, which the setup panel installed
//! (see deps.rs). Everything being worked on stays in `<final name>.parts/` next to where the file will end up, which is how a stream
//! continues after a pause or a crash and what gets deleted when it's cancelled.

use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use serde::Deserialize;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::watch;

use crate::deps::{self, FFMPEG, YT_DLP};
use crate::transfers::{
    numbered, sanitize, stopped, Event, Job, Signal, Status, Stop, Transfers, EVENT, PROGRESS_EVERY,
};

/// Until the stream says otherwise. Only ever seen while the download is in progress.
const PLANNED_EXTENSION: &str = "mp4";
const OUTPUT_TEMPLATE: &str = "media.%(ext)s";
/// What a stream becomes in its working folder, once it's a proper file. Not `media.*`.
const REMUX_STEM: &str = "final";
const MPEG_TS_PACKET: usize = 188;
const MPEG_TS_SYNC: u8 = 0x47;
const PROGRESS_MARK: &str = "strem-dl-progress ";
const FILE_MARK: &str = "strem-dl-file ";
const PROBE_TIMEOUT: Duration = Duration::from_secs(20);
const STOP_GRACE: Duration = Duration::from_secs(3);

/// Where a stream's working files live.
pub fn parts_path(path: &Path) -> PathBuf {
    let mut name = OsString::from(path.as_os_str());
    name.push(".parts");
    PathBuf::from(name)
}

/// Whether yt-dlp itself understands this page. Doesn't save anything.
#[tauri::command]
pub async fn media_probe(app: AppHandle, state: State<'_, Transfers>, url: String) -> Result<bool, String> {
    if !is_web_address(&url) {
        return Ok(false);
    }
    let mut command = command(&deps::executable(&app, YT_DLP)?);
    command
        .args(probe_args(&url))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = command.spawn().map_err(|error| format!("Couldn't start yt-dlp: {error}"))?;
    let tree = ProcessTree::of(&child);
    let key = state.track_process(tree.clone());

    let finished = tokio::time::timeout(PROBE_TIMEOUT, async {
        let mut output = String::new();
        if let Some(stdout) = child.stdout.take() {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                output.push_str(&line);
            }
        }
        let success = child.wait().await.is_ok_and(|status| status.success());
        success && !output.trim().is_empty()
    })
    .await;

    state.forget_process(key);
    match finished {
        Ok(found) => Ok(found),
        Err(_) => {
            tree.kill();
            let _ = child.wait().await;
            Ok(false)
        }
    }
}

pub async fn download(
    transfers: &Transfers,
    job: &Job,
    signal: &mut watch::Receiver<Signal>,
    status: &mut Status,
    app: &AppHandle,
) -> Result<PathBuf, Stop> {
    let path = match job.file_path.as_deref() {
        Some(known) => {
            let path = PathBuf::from(known);
            tokio::fs::create_dir_all(parts_path(&path)).await?;
            path
        }
        None => {
            let folder = job.folder.as_deref().ok_or_else(|| {
                Stop::Failed("No download folder set. Choose one in Settings".into())
            })?;
            claim_name(Path::new(folder), &job.fallback_name).await?
        }
    };
    let parts = parts_path(&path);
    status.parts = Some(parts.clone());
    status.done = folder_size(&parts).await;
    let _ = app.emit(
        EVENT,
        Event::Started {
            id: job.id.clone(),
            file_path: path.to_string_lossy().into_owned(),
            total: None,
            validator: None,
            done: status.done,
            restarted: false,
        },
    );

    let ffmpeg = deps::executable(app, FFMPEG).map_err(Stop::Failed)?;
    let mut command = command(&deps::executable(app, YT_DLP).map_err(Stop::Failed)?);
    command
        .args(download_args(
            &job.url,
            job.referer.as_deref(),
            job.user_agent.as_deref(),
            &ffmpeg,
            &parts,
        ))
        .current_dir(&parts)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| Stop::Failed(format!("Couldn't start yt-dlp: {error}")))?;
    let tree = ProcessTree::of(&child);
    let key = transfers.track_process(tree.clone());
    let result = watch_child(&mut child, &tree, job, signal, status, app).await;
    transfers.forget_process(key);
    let output = result?;

    let finished = match output.file {
        Some(name) => {
            let file = parts.join(Path::new(&name).file_name().unwrap_or(OsStr::new(&name)));
            tokio::fs::try_exists(&file).await.unwrap_or(false).then_some(file)
        }
        None => None,
    };
    let finished = match finished {
        Some(file) => Some(file),
        None => find_result(&parts).await,
    };
    let Some(finished) = finished else {
        return Err(Stop::Failed(output.failure.unwrap_or_else(|| "yt-dlp finished without saving a file".into())));
    };

    let finished = if is_mpeg_ts(&finished).await {
        let _ = app.emit(EVENT, Event::Stage { id: job.id.clone(), stage: "merging".into() });
        remux(transfers, &ffmpeg, &finished, &parts, signal).await?
    } else {
        finished
    };

    status.done = tokio::fs::metadata(&finished).await.map_or(status.done, |meta| meta.len());
    let extension = finished.extension().map(OsStr::to_os_string);
    let target = crate::transfers::free_path(&final_path(&path, extension.as_deref())).await;
    tokio::fs::rename(&finished, &target).await?;
    let _ = tokio::fs::remove_dir_all(&parts).await;
    Ok(target)
}

struct Output {
    file: Option<String>,
    /// Why it finished without a file, for a run that exited without an error.
    failure: Option<String>,
}

async fn watch_child(
    child: &mut Child,
    tree: &ProcessTree,
    job: &Job,
    signal: &mut watch::Receiver<Signal>,
    status: &mut Status,
    app: &AppHandle,
) -> Result<Output, Stop> {
    let stdout = child.stdout.take().expect("stdout is piped");
    let stderr = child.stderr.take().expect("stderr is piped");
    let errors = tauri::async_runtime::spawn(async move {
        let mut last = None;
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(error) = line.strip_prefix("ERROR: ") {
                last = Some(error.to_string());
            }
        }
        last
    });

    let mut lines = BufReader::new(stdout).lines();
    let mut streams = Streams::default();
    let mut output = Output { file: None, failure: None };
    let mut last_emit = Instant::now() - PROGRESS_EVERY;
    let mut merging = false;
    loop {
        let line = tokio::select! {
            line = lines.next_line() => line?,
            stop = stopped(signal) => {
                stop_child(child, tree).await;
                return Err(stop);
            }
        };
        let Some(line) = line else { break };
        match read_line(&line) {
            Line::Progress(progress) => {
                let (done, total, speed) = streams.update(progress);
                status.done = done;
                if last_emit.elapsed() >= PROGRESS_EVERY {
                    last_emit = Instant::now();
                    let _ = app.emit(EVENT, Event::Progress { id: job.id.clone(), done, total, speed });
                }
            }
            Line::File(name) => output.file = Some(name),
            Line::Merging if !merging => {
                merging = true;
                let _ = app.emit(EVENT, Event::Stage { id: job.id.clone(), stage: "merging".into() });
            }
            Line::Skipped => output.failure = Some("Live streams can't be saved".into()),
            Line::Merging | Line::Other => {}
        }
    }

    let exit = tokio::select! {
        exit = child.wait() => exit?,
        stop = stopped(signal) => {
            stop_child(child, tree).await;
            return Err(stop);
        }
    };
    let error = errors.await.ok().flatten();
    if exit.success() {
        return Ok(output);
    }
    let error = error.unwrap_or_else(|| format!("yt-dlp stopped unexpectedly ({exit})"));
    Err(if looks_expired(&error) {
        Stop::Expired(friendly_error(&error))
    } else {
        Stop::Failed(friendly_error(&error))
    })
}

/// Ask nicely, then insist. Whatever's on disk stays good for continuing.
async fn stop_child(child: &mut Child, tree: &ProcessTree) {
    tree.terminate();
    if tokio::time::timeout(STOP_GRACE, child.wait()).await.is_err() {
        tree.kill();
        let _ = child.wait().await;
    }
}

/// Pick a name no file or other stream is using, by creating its working folder.
async fn claim_name(folder: &Path, fallback: &str) -> Result<PathBuf, Stop> {
    tokio::fs::create_dir_all(folder).await?;
    let stem = sanitize(fallback);
    let stem = if stem.is_empty() { "download".to_string() } else { stem };
    let name = format!("{stem}.{PLANNED_EXTENSION}");
    for attempt in 0..10_000 {
        let path = folder.join(numbered(&name, attempt));
        if tokio::fs::try_exists(&path).await? {
            continue;
        }
        match tokio::fs::create_dir(parts_path(&path)).await {
            Ok(()) => return Ok(path),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.into()),
        }
    }
    Err(Stop::Failed(format!("Too many files named {name}")))
}

/// HLS pieces joined up are MPEG-TS whatever the name says: they play, but seeking is poor.
async fn is_mpeg_ts(path: &Path) -> bool {
    use tokio::io::AsyncReadExt;
    let mut start = [0; MPEG_TS_PACKET + 1];
    let Ok(mut file) = tokio::fs::File::open(path).await else {
        return false;
    };
    file.read_exact(&mut start).await.is_ok() && is_mpeg_ts_start(&start)
}

fn is_mpeg_ts_start(start: &[u8]) -> bool {
    start.first() == Some(&MPEG_TS_SYNC) && start.get(MPEG_TS_PACKET) == Some(&MPEG_TS_SYNC)
}

/// Change the container without touching the video. MP4 if the codecs fit, else Matroska,
/// else it stays as it is: a file with an odd container beats no file.
async fn remux(
    transfers: &Transfers,
    ffmpeg: &Path,
    input: &Path,
    parts: &Path,
    signal: &mut watch::Receiver<Signal>,
) -> Result<PathBuf, Stop> {
    for (extension, format) in [("mp4", "mp4"), ("mkv", "matroska")] {
        let output = parts.join(format!("{REMUX_STEM}.{extension}"));
        let mut child = command(ffmpeg)
            .args(remux_args(input, &output, format))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| Stop::Failed(format!("Couldn't start ffmpeg: {error}")))?;
        let tree = ProcessTree::of(&child);
        let key = transfers.track_process(tree.clone());
        let exit = tokio::select! {
            exit = child.wait() => exit,
            stop = stopped(signal) => {
                stop_child(&mut child, &tree).await;
                transfers.forget_process(key);
                return Err(stop);
            }
        };
        transfers.forget_process(key);
        if exit.is_ok_and(|status| status.success()) {
            return Ok(output);
        }
        let _ = tokio::fs::remove_file(&output).await;
    }
    let plain = input.with_extension("ts");
    tokio::fs::rename(input, &plain).await?;
    Ok(plain)
}

fn remux_args(input: &Path, output: &Path, format: &str) -> Vec<OsString> {
    let mut args: Vec<OsString> = ["-nostdin", "-v", "error", "-y", "-i"].map(OsString::from).to_vec();
    args.push(input.into());
    // Timed metadata streams, common in HLS, can't go in an MP4 and aren't wanted.
    args.extend(["-map", "0:v?", "-map", "0:a?", "-c", "copy"].map(OsString::from));
    if format == "mp4" {
        args.extend(["-movflags", "+faststart"].map(OsString::from));
    }
    args.extend(["-f", format].map(OsString::from));
    args.push(output.into());
    args
}

fn final_path(planned: &Path, extension: Option<&OsStr>) -> PathBuf {
    match extension {
        Some(extension) => planned.with_extension(extension),
        None => planned.to_path_buf(),
    }
}

/// In case yt-dlp didn't say: it had already finished when the app last closed.
async fn find_result(parts: &Path) -> Option<PathBuf> {
    let mut entries = tokio::fs::read_dir(parts).await.ok()?;
    let mut names = Vec::new();
    while let Ok(Some(entry)) = entries.next_entry().await {
        names.push(entry.file_name().to_string_lossy().into_owned());
    }
    result_among(&names).map(|name| parts.join(name))
}

/// `media.mp4` is a result. `media.mp4.part`, `media.mp4.ytdl` and `media.f1.mp4` are not.
fn result_among(names: &[String]) -> Option<&String> {
    names.iter().find(|name| {
        let mut pieces = name.split('.');
        pieces.next() == Some("media")
            && pieces.next().is_some_and(|extension| !matches!(extension, "part" | "ytdl" | "temp"))
            && pieces.next().is_none()
    })
}

async fn folder_size(folder: &Path) -> u64 {
    let Ok(mut entries) = tokio::fs::read_dir(folder).await else {
        return 0;
    };
    let mut total = 0;
    while let Ok(Some(entry)) = entries.next_entry().await {
        total += entry.metadata().await.map_or(0, |meta| meta.len());
    }
    total
}

fn is_web_address(url: &str) -> bool {
    tauri::Url::parse(url).is_ok_and(|url| matches!(url.scheme(), "http" | "https"))
}

/// An AppImage points these at its own libraries, which aren't meant for other programs.
pub fn clean_environment(command: &mut Command) {
    for name in ["LD_LIBRARY_PATH", "LD_PRELOAD", "PYTHONPATH", "PYTHONHOME"] {
        command.env_remove(name);
    }
}

/// A process that stays in the app's control, with a clean environment.
pub fn command(program: &Path) -> Command {
    let mut command = Command::new(program);
    clean_environment(&mut command);
    command.kill_on_drop(true);
    ProcessTree::prepare(&mut command);
    command
}

/// Settings that keep other people's pages and this machine's config from steering yt-dlp.
fn common_args() -> Vec<OsString> {
    ["--ignore-config", "--no-plugin-dirs", "--no-update", "--no-cache-dir", "--no-playlist", "--color", "never"]
        .iter()
        .map(OsString::from)
        .collect()
}

fn probe_args(url: &str) -> Vec<OsString> {
    let mut args = common_args();
    args.extend(["--simulate", "--no-warnings", "--socket-timeout", "10", "--print", "id", "--"].map(OsString::from));
    args.push(url.into());
    args
}

fn download_args(
    url: &str,
    referer: Option<&str>,
    user_agent: Option<&str>,
    ffmpeg: &Path,
    parts: &Path,
) -> Vec<OsString> {
    let mut args = common_args();
    args.extend(
        [
            // The default is to skip what it can't fetch, leaving holes in the video.
            "--abort-on-unavailable-fragments",
            "--retries",
            "10",
            "--fragment-retries",
            "10",
            "--concurrent-fragments",
            "4",
            "--socket-timeout",
            "30",
            // Its fixes need ffprobe. MPEG-TS gets remuxed here instead.
            "--fixup",
            "never",
            // A live stream would never finish.
            "--match-filter",
            "!is_live",
            "-f",
            "bv*+ba/b",
            "--merge-output-format",
            "mp4/mkv",
            "--no-mtime",
            "--continue",
            "--no-simulate",
            "--no-quiet",
            "--newline",
            "--progress-delta",
            "0.25",
            "--progress-template",
        ]
        .map(OsString::from),
    );
    args.push(format!("download:{PROGRESS_MARK}%(progress)j").into());
    args.push("--print".into());
    args.push(format!("after_move:{FILE_MARK}%(filepath)s").into());
    args.push("--ffmpeg-location".into());
    args.push(ffmpeg.into());
    args.push("-P".into());
    args.push(parts.into());
    args.push("-o".into());
    args.push(OUTPUT_TEMPLATE.into());
    if let Some(referer) = referer {
        args.push("--referer".into());
        args.push(referer.into());
    }
    if let Some(user_agent) = user_agent {
        args.push("--user-agent".into());
        args.push(user_agent.into());
    }
    // Nothing after this can be read as an option, whatever the address holds.
    args.push("--".into());
    args.push(url.into());
    args
}

#[derive(Debug, Default, Deserialize, PartialEq)]
struct Progress {
    filename: Option<String>,
    downloaded_bytes: Option<f64>,
    total_bytes: Option<f64>,
    total_bytes_estimate: Option<f64>,
    speed: Option<f64>,
}

#[derive(Debug, PartialEq)]
enum Line {
    Progress(Progress),
    File(String),
    Merging,
    Skipped,
    Other,
}

fn read_line(line: &str) -> Line {
    if let Some(json) = line.strip_prefix(PROGRESS_MARK) {
        return serde_json::from_str(json).map_or(Line::Other, Line::Progress);
    }
    if let Some(file) = line.strip_prefix(FILE_MARK) {
        return Line::File(file.to_string());
    }
    if line.starts_with("[Merger]") {
        return Line::Merging;
    }
    if line.contains("does not pass filter") {
        return Line::Skipped;
    }
    Line::Other
}

/// Video and audio download one after the other, so progress adds up across streams.
#[derive(Default)]
struct Streams {
    known: HashMap<String, (u64, Option<u64>)>,
}

impl Streams {
    fn update(&mut self, progress: Progress) -> (u64, Option<u64>, f64) {
        let total = progress.total_bytes.or(progress.total_bytes_estimate).map(|value| value as u64);
        let name = progress.filename.unwrap_or_default();
        let stream = self.known.entry(name).or_insert((0, None));
        if let Some(done) = progress.downloaded_bytes {
            stream.0 = done as u64;
        }
        if total.is_some() {
            stream.1 = total;
        }
        let done = self.known.values().map(|(done, _)| done).sum();
        let total = self.known.values().map(|(_, total)| *total).sum();
        (done, total, progress.speed.unwrap_or(0.0))
    }
}

/// A link that stopped working is worth finding again. Other failures aren't.
fn looks_expired(error: &str) -> bool {
    ["HTTP Error 401", "HTTP Error 403", "HTTP Error 404", "HTTP Error 410"]
        .iter()
        .any(|code| error.contains(code))
        || (error.contains("fragment") && error.contains("not found"))
}

fn friendly_error(error: &str) -> String {
    if error.contains("DRM") {
        return "This video is DRM protected, so it can't be saved".into();
    }
    if error.contains("Unsupported URL") {
        return "No video found at this address".into();
    }
    if looks_expired(error) {
        return "The video's link has expired. Press Resume to find it again".into();
    }
    error.to_string()
}

/// A program and everything it started: yt-dlp is a launcher, its real work happens in a
/// child process, and that starts ffmpeg.
#[derive(Clone)]
pub struct ProcessTree(platform::Handle);

impl ProcessTree {
    fn prepare(command: &mut Command) {
        platform::prepare(command);
    }

    fn of(child: &Child) -> Self {
        Self(platform::handle_of(child))
    }

    /// Lets them tidy up. Windows has no such thing, so there it's the same as `kill`.
    fn terminate(&self) {
        platform::terminate(&self.0);
    }

    pub fn kill(&self) {
        platform::kill(&self.0);
    }
}

#[cfg(unix)]
mod platform {
    use tokio::process::{Child, Command};

    /// Process group ID. None if the child had already gone.
    pub type Handle = Option<i32>;

    pub fn prepare(command: &mut Command) {
        command.process_group(0);
        #[cfg(target_os = "linux")]
        // SAFETY: prctl is async-signal-safe, and this allocates nothing.
        unsafe {
            command.pre_exec(|| {
                // If the app is killed outright, nothing else would stop these.
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM) == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }

    pub fn handle_of(child: &Child) -> Handle {
        child.id().map(|id| id as i32)
    }

    fn signal(handle: &Handle, signal: i32) {
        if let Some(group) = handle {
            // SAFETY: only sends a signal, to a group this process created.
            unsafe { libc::kill(-group, signal) };
        }
    }

    pub fn terminate(handle: &Handle) {
        signal(handle, libc::SIGTERM);
    }

    pub fn kill(handle: &Handle) {
        signal(handle, libc::SIGKILL);
    }
}

#[cfg(windows)]
mod platform {
    use std::sync::Arc;

    use tokio::process::{Child, Command};
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;

    /// A job takes everything the process starts with it, including when the app dies.
    pub struct Job(HANDLE);

    // SAFETY: a job handle can be used from any thread.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    impl Drop for Job {
        fn drop(&mut self) {
            // SAFETY: the handle is ours, and closing it is what ends the job's processes.
            unsafe { CloseHandle(self.0) };
        }
    }

    pub type Handle = Option<Arc<Job>>;

    pub fn prepare(command: &mut Command) {
        command.creation_flags(CREATE_NO_WINDOW);
    }

    pub fn handle_of(child: &Child) -> Handle {
        let process = child.raw_handle()?;
        // SAFETY: a null name and attributes ask for a new, private job. The structure is
        // zeroed as the API allows, and each handle is checked before use.
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return None;
            }
            let job = Job(job);
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let set = SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if set == 0 || AssignProcessToJobObject(job.0, process as HANDLE) == 0 {
                return None;
            }
            Some(Arc::new(job))
        }
    }

    pub fn terminate(handle: &Handle) {
        kill(handle);
    }

    pub fn kill(handle: &Handle) {
        if let Some(job) = handle {
            // SAFETY: the job is alive for as long as this reference.
            unsafe { TerminateJobObject(job.0, 1) };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(args: &[OsString]) -> Vec<String> {
        args.iter().map(|arg| arg.to_string_lossy().into_owned()).collect()
    }

    fn args() -> Vec<String> {
        text(&download_args(
            "https://cdn.example/master.m3u8?t=1",
            Some("https://host.example/e/1"),
            Some("Mozilla/5.0"),
            Path::new("/app/ffmpeg"),
            Path::new("/dl/film.mp4.parts"),
        ))
    }

    fn value_of(args: &[String], option: &str) -> String {
        let at = args.iter().position(|arg| arg == option).unwrap_or_else(|| panic!("{option} missing"));
        args[at + 1].clone()
    }

    #[test]
    fn an_address_can_never_be_read_as_an_option() {
        for args in [
            text(&download_args("--exec=rm -rf /", None, None, Path::new("/f"), Path::new("/p"))),
            text(&probe_args("--exec=rm -rf /")),
        ] {
            assert_eq!(args[args.len() - 2], "--");
            assert_eq!(args[args.len() - 1], "--exec=rm -rf /");
            assert!(!args[..args.len() - 2].iter().any(|arg| arg.contains("rm -rf")));
        }
    }

    #[test]
    fn ignores_config_and_plugins_on_this_machine() {
        for args in [args(), text(&probe_args("https://a.example/"))] {
            for option in ["--ignore-config", "--no-plugin-dirs", "--no-update"] {
                assert!(args.iter().any(|arg| arg == option), "{option}");
            }
            assert!(!args.iter().any(|arg| arg == "--exec"));
        }
    }

    #[test]
    fn fails_rather_than_leaving_holes_in_the_video() {
        assert!(args().iter().any(|arg| arg == "--abort-on-unavailable-fragments"));
    }

    #[test]
    fn names_stay_ours_and_work_stays_in_the_parts_folder() {
        let args = args();
        assert_eq!(value_of(&args, "-o"), "media.%(ext)s");
        assert_eq!(value_of(&args, "-P"), "/dl/film.mp4.parts");
        assert_eq!(value_of(&args, "--ffmpeg-location"), "/app/ffmpeg");
    }

    #[test]
    fn sends_what_the_page_sent_only_if_known() {
        let args = args();
        assert_eq!(value_of(&args, "--referer"), "https://host.example/e/1");
        assert_eq!(value_of(&args, "--user-agent"), "Mozilla/5.0");

        let bare = text(&download_args("https://a.example/", None, None, Path::new("/f"), Path::new("/p")));
        assert!(!bare.iter().any(|arg| arg == "--referer" || arg == "--user-agent"));
    }

    #[test]
    fn reads_progress_lines() {
        let line = r#"strem-dl-progress {"status":"downloading","filename":"media.mp4","downloaded_bytes":100,"total_bytes":null,"total_bytes_estimate":1000.5,"speed":50.0,"eta":18}"#;
        assert_eq!(
            read_line(line),
            Line::Progress(Progress {
                filename: Some("media.mp4".into()),
                downloaded_bytes: Some(100.0),
                total_bytes: None,
                total_bytes_estimate: Some(1000.5),
                speed: Some(50.0),
            })
        );
    }

    #[test]
    fn reads_the_other_lines_it_cares_about() {
        assert_eq!(read_line("strem-dl-file /p/media.mp4"), Line::File("/p/media.mp4".into()));
        assert_eq!(read_line("[Merger] Merging formats into \"media.mp4\""), Line::Merging);
        assert_eq!(read_line("[info] x: does not pass filter (!is_live), skipping .."), Line::Skipped);
        assert_eq!(read_line("[generic] Downloading webpage"), Line::Other);
        assert_eq!(read_line("strem-dl-progress not json"), Line::Other);
    }

    #[test]
    fn progress_adds_up_across_streams() {
        let mut streams = Streams::default();
        let update = |streams: &mut Streams, name: &str, done: f64, total: Option<f64>| {
            streams.update(Progress {
                filename: Some(name.into()),
                downloaded_bytes: Some(done),
                total_bytes: total,
                total_bytes_estimate: None,
                speed: Some(7.0),
            })
        };
        assert_eq!(update(&mut streams, "video", 50.0, Some(100.0)), (50, Some(100), 7.0));
        assert_eq!(update(&mut streams, "video", 100.0, Some(100.0)), (100, Some(100), 7.0));
        assert_eq!(update(&mut streams, "audio", 5.0, Some(20.0)), (105, Some(120), 7.0));
    }

    #[test]
    fn total_is_unknown_until_every_stream_has_one() {
        let mut streams = Streams::default();
        streams.update(Progress {
            filename: Some("video".into()),
            downloaded_bytes: Some(1.0),
            total_bytes: Some(10.0),
            ..Progress::default()
        });
        let (done, total, speed) = streams.update(Progress {
            filename: Some("audio".into()),
            downloaded_bytes: Some(1.0),
            ..Progress::default()
        });
        assert_eq!((done, total, speed), (2, None, 0.0));
    }

    #[test]
    fn tells_an_expired_link_from_other_failures() {
        assert!(looks_expired("unable to download video data: HTTP Error 403: Forbidden"));
        assert!(looks_expired("fragment 5 not found, unable to continue"));
        assert!(!looks_expired("HTTP Error 500: Server Error"));
        assert!(!looks_expired("Unsupported URL: https://a.example/"));
    }

    #[test]
    fn explains_failures_people_can_act_on() {
        assert!(friendly_error("[x] This video is DRM protected").contains("can't be saved"));
        assert!(friendly_error("HTTP Error 410: Gone").contains("Press Resume"));
        assert_eq!(friendly_error("Disk quota exceeded"), "Disk quota exceeded");
    }

    #[test]
    fn recognises_mpeg_ts_by_its_packets() {
        let mut ts = vec![0; MPEG_TS_PACKET + 1];
        ts[0] = MPEG_TS_SYNC;
        ts[MPEG_TS_PACKET] = MPEG_TS_SYNC;
        assert!(is_mpeg_ts_start(&ts));
        ts[MPEG_TS_PACKET] = 0;
        assert!(!is_mpeg_ts_start(&ts));
        assert!(!is_mpeg_ts_start(b"\x00\x00\x00\x20ftypisom"));
        assert!(!is_mpeg_ts_start(&[]));
    }

    #[test]
    fn remuxing_copies_the_video_and_never_reads_an_address() {
        let args = text(&remux_args(Path::new("/p/media.mp4"), Path::new("/p/final.mp4"), "mp4"));
        assert_eq!(value_of(&args, "-c"), "copy");
        assert_eq!(value_of(&args, "-i"), "/p/media.mp4");
        assert_eq!(args.last().unwrap(), "/p/final.mp4");
        assert!(args.iter().any(|arg| arg == "-nostdin"));

        let mkv = text(&remux_args(Path::new("/p/a"), Path::new("/p/b"), "matroska"));
        assert_eq!(value_of(&mkv, "-f"), "matroska");
        assert!(!mkv.iter().any(|arg| arg == "-movflags"));
    }

    #[test]
    fn finds_the_result_among_working_files() {
        let names = |list: &[&str]| list.iter().map(|name| name.to_string()).collect::<Vec<_>>();
        let has = names(&["media.mp4.part", "media.f1.mp4", "media.mp4.ytdl", "media.mkv"]);
        assert_eq!(result_among(&has).map(String::as_str), Some("media.mkv"));
        let not_yet = names(&["media.mp4.part", "media.f1.mp4", "media.f2.m4a", "media.temp.mp4"]);
        assert_eq!(result_among(&not_yet), None);
    }

    #[test]
    fn the_final_name_takes_the_stream_s_real_extension() {
        let planned = Path::new("/dl/Ep. 1.mp4");
        assert_eq!(final_path(planned, Some(OsStr::new("mkv"))), Path::new("/dl/Ep. 1.mkv"));
        assert_eq!(final_path(planned, None), planned);
        assert_eq!(parts_path(planned), Path::new("/dl/Ep. 1.mp4.parts"));
    }
}
