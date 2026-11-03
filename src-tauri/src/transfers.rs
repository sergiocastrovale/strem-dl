//! Downloads files to disk. Only moves bytes: the queue and saved state live in the
//! frontend (src/lib/downloads.ts). The `.part` file on disk is the record of how far a
//! download got, so a transfer can continue after the app was killed.

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use percent_encoding::percent_decode_str;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_http::reqwest::{header, Client, Response, StatusCode, Url};
use tokio::io::{AsyncSeekExt, AsyncWriteExt};
use tokio::sync::watch;

use crate::media::{self, ProcessTree};

pub const EVENT: &str = "transfer";
pub const PROGRESS_EVERY: Duration = Duration::from_millis(250);
const MAX_NAME_BYTES: usize = 200;

#[derive(Clone, Copy, PartialEq)]
pub enum Signal {
    Run,
    Pause,
    Cancel,
}

pub struct Transfers {
    running: Arc<Mutex<HashMap<String, watch::Sender<Signal>>>>,
    client: Client,
    processes: Mutex<HashMap<u64, ProcessTree>>,
    next_process: AtomicU64,
}

impl Transfers {
    pub fn new() -> Self {
        let client = Client::builder()
            .user_agent(concat!("strem-dl/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(Duration::from_secs(30))
            .read_timeout(Duration::from_secs(60))
            .build()
            .expect("failed to set up the HTTP client");
        Self {
            running: Arc::default(),
            client,
            processes: Mutex::default(),
            next_process: AtomicU64::new(0),
        }
    }

    pub fn client(&self) -> Client {
        self.client.clone()
    }

    pub fn has_processes(&self) -> bool {
        !self.processes.lock().expect("process list poisoned").is_empty()
    }

    pub fn track_process(&self, tree: ProcessTree) -> u64 {
        let key = self.next_process.fetch_add(1, Ordering::Relaxed);
        self.processes.lock().expect("process list poisoned").insert(key, tree);
        key
    }

    pub fn forget_process(&self, key: u64) {
        self.processes.lock().expect("process list poisoned").remove(&key);
    }

    /// Nothing the app started may outlive it.
    pub fn kill_processes(&self) {
        for tree in self.processes.lock().expect("process list poisoned").values() {
            tree.kill();
        }
    }
}

/// How the bytes get here.
#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    /// One file, fetched directly.
    #[default]
    File,
    /// A stream of pieces. See media.rs.
    Media,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    pub url: String,
    pub fallback_name: String,
    /// Where to save a new download. Unused once `file_path` is known.
    pub folder: Option<String>,
    pub file_path: Option<String>,
    /// ETag or Last-Modified from the first response, to tell if the file changed.
    validator: Option<String>,
    #[serde(default)]
    mode: Mode,
    /// Sent the way the page that led here would have. Some servers refuse anyone else.
    pub referer: Option<String>,
    pub user_agent: Option<String>,
    /// Name it `fallback_name`, because the address says nothing useful.
    #[serde(default)]
    exact_name: bool,
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Event {
    Started {
        id: String,
        file_path: String,
        total: Option<u64>,
        validator: Option<String>,
        done: u64,
        /// Had bytes to continue from, but the server made us start over.
        restarted: bool,
    },
    Progress {
        id: String,
        done: u64,
        total: Option<u64>,
        speed: f64,
    },
    Finished {
        id: String,
        file_path: String,
        done: u64,
    },
    /// Bytes are all here, and now they're being made into a file.
    Stage {
        id: String,
        stage: String,
    },
    Paused {
        id: String,
        done: u64,
    },
    Failed {
        id: String,
        done: u64,
        error: String,
        /// The link stopped working. Finding it again might fix this.
        expired: bool,
    },
}

pub enum Stop {
    Paused,
    Cancelled,
    Failed(String),
    Expired(String),
}

impl From<std::io::Error> for Stop {
    fn from(error: std::io::Error) -> Self {
        Stop::Failed(error.to_string())
    }
}

/// How far a running transfer got, readable however it ended.
#[derive(Default)]
pub struct Status {
    pub done: u64,
    part: Option<PathBuf>,
    pub parts: Option<PathBuf>,
}

#[tauri::command]
pub fn download_start(app: AppHandle, state: State<'_, Transfers>, job: Job) -> Result<(), String> {
    let scheme_ok = Url::parse(&job.url).is_ok_and(|url| matches!(url.scheme(), "http" | "https"));
    if !scheme_ok {
        return Err("Only http and https links can be downloaded".into());
    }
    let unsafe_header = |value: &Option<String>| value.as_deref().is_some_and(|text| text.chars().any(char::is_control));
    if unsafe_header(&job.referer) || unsafe_header(&job.user_agent) {
        return Err("This link has invalid request details".into());
    }

    let (sender, mut signal) = watch::channel(Signal::Run);
    {
        let mut running = state.running.lock().expect("transfer list poisoned");
        if running.contains_key(&job.id) {
            return Err("This download is already running".into());
        }
        running.insert(job.id.clone(), sender);
    }

    let client = state.client.clone();
    let running = state.running.clone();
    let spawned_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let app = spawned_app;
        let transfers = app.state::<Transfers>();
        let mut status = Status::default();
        let result = match job.mode {
            Mode::File => transfer(&client, &job, &mut signal, &mut status, &app).await,
            Mode::Media => media::download(&transfers, &job, &mut signal, &mut status, &app).await,
        };
        let id = job.id.clone();
        let done = status.done;
        let event = match result {
            Ok(path) => Some(Event::Finished {
                id,
                file_path: path.to_string_lossy().into_owned(),
                done,
            }),
            Err(Stop::Paused) => Some(Event::Paused { id, done }),
            Err(Stop::Failed(error)) => Some(Event::Failed { id, done, error, expired: false }),
            Err(Stop::Expired(error)) => Some(Event::Failed { id, done, error, expired: true }),
            Err(Stop::Cancelled) => {
                if let Some(part) = &status.part {
                    let _ = tokio::fs::remove_file(part).await;
                }
                if let Some(parts) = &status.parts {
                    let _ = tokio::fs::remove_dir_all(parts).await;
                }
                None
            }
        };
        // Before the event, so whoever hears it can start this download again.
        running.lock().expect("transfer list poisoned").remove(&job.id);
        if let Some(event) = event {
            let _ = app.emit(EVENT, event);
        }
    });
    Ok(())
}

#[tauri::command]
pub fn download_pause(state: State<'_, Transfers>, id: String) {
    let running = state.running.lock().expect("transfer list poisoned");
    if let Some(sender) = running.get(&id) {
        let _ = sender.send(Signal::Pause);
    }
}

/// Stop a download and delete what it has so far. Never touches a finished file.
#[tauri::command]
pub async fn download_cancel(
    state: State<'_, Transfers>,
    id: String,
    file_path: Option<String>,
) -> Result<(), String> {
    {
        let running = state.running.lock().expect("transfer list poisoned");
        if let Some(sender) = running.get(&id) {
            let _ = sender.send(Signal::Cancel);
            return Ok(());
        }
    }
    if let Some(path) = file_path {
        let path = Path::new(&path);
        let removed = [
            tokio::fs::remove_file(part_path(path)).await,
            tokio::fs::remove_dir_all(media::parts_path(path)).await,
        ];
        for result in removed {
            match result {
                Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                    return Err(error.to_string())
                }
                _ => {}
            }
        }
    }
    Ok(())
}

/// Make sure downloads can be saved in this folder, creating it if needed.
#[tauri::command]
pub async fn check_download_folder(path: String) -> Result<(), String> {
    let folder = Path::new(&path);
    if !folder.is_absolute() {
        return Err("Enter a full path, starting from the root of the disk".into());
    }
    tokio::fs::create_dir_all(folder)
        .await
        .map_err(|error| format!("Can't create this folder: {error}"))?;
    let probe = folder.join(".strem-dl-write-check");
    tokio::fs::write(&probe, b"")
        .await
        .map_err(|error| format!("Can't save files in this folder: {error}"))?;
    let _ = tokio::fs::remove_file(&probe).await;
    Ok(())
}

async fn transfer(
    client: &Client,
    job: &Job,
    signal: &mut watch::Receiver<Signal>,
    status: &mut Status,
    app: &AppHandle,
) -> Result<PathBuf, Stop> {
    let known = job.file_path.as_deref().map(PathBuf::from);
    if let Some(path) = &known {
        status.part = Some(part_path(path));
    }
    let offset = match &status.part {
        Some(part) => tokio::fs::metadata(part).await.map_or(0, |meta| meta.len()),
        None => 0,
    };
    status.done = offset;

    let mut from = offset;
    let mut response = send(client, job, from, signal).await?;
    if from > 0 && response.status() == StatusCode::RANGE_NOT_SATISFIABLE {
        // Everything was saved, and only the rename is missing.
        if content_range(&response).and_then(|(_, total)| total) == Some(offset) {
            let path = known.as_ref().expect("an offset comes from a known path");
            return finish(path).await;
        }
    }
    if from > 0 && !continues_at(&response, from, job.validator.as_deref()) {
        from = 0;
        // A 200 already is the whole file; anything else has to be asked for again.
        if response.status() != StatusCode::OK {
            response = send(client, job, 0, signal).await?;
        }
    }
    if !response.status().is_success() {
        let status = response.status();
        return Err(if is_expired_status(status) {
            Stop::Expired(http_error(status))
        } else {
            Stop::Failed(http_error(status))
        });
    }
    let headers = response.headers();
    if from == 0 && is_page(headers) {
        // Video hosts answer an expired link with their home page.
        return Err(Stop::Expired("The link returned a web page, not a file".into()));
    }

    let total = total_size(&response, from);
    let validator = validator_of(headers).or_else(|| job.validator.clone());
    let (path, mut file) = match known {
        Some(path) => {
            if let Some(parent) = path.parent() {
                tokio::fs::create_dir_all(parent).await?;
            }
            let file = open_part(&part_path(&path), from).await?;
            (path, file)
        }
        None => {
            let folder = job.folder.as_deref().ok_or_else(|| {
                Stop::Failed("No download folder set. Choose one in Settings".into())
            })?;
            tokio::fs::create_dir_all(folder).await?;
            let name = if job.exact_name {
                exact_name(headers, &job.fallback_name)
            } else {
                choose_name(headers, response.url(), &job.fallback_name)
            };
            create_unique(Path::new(folder), &name).await?
        }
    };
    status.part = Some(part_path(&path));
    status.done = from;
    let _ = app.emit(
        EVENT,
        Event::Started {
            id: job.id.clone(),
            file_path: path.to_string_lossy().into_owned(),
            total,
            validator,
            done: from,
            restarted: offset > 0 && from == 0,
        },
    );

    let mut last_emit = Instant::now();
    let mut last_done = from;
    let mut speed = 0.0_f64;
    loop {
        let chunk = tokio::select! {
            chunk = response.chunk() => chunk,
            stop = stopped(signal) => {
                file.flush().await?;
                return Err(stop);
            }
        };
        let chunk = match chunk {
            Ok(Some(chunk)) => chunk,
            Ok(None) => break,
            Err(error) => {
                file.flush().await?;
                return Err(Stop::Failed(format!("Connection lost: {}", describe(&error))));
            }
        };
        file.write_all(&chunk).await?;
        status.done += chunk.len() as u64;

        let elapsed = last_emit.elapsed();
        if elapsed >= PROGRESS_EVERY {
            let current = (status.done - last_done) as f64 / elapsed.as_secs_f64();
            speed = if speed == 0.0 { current } else { speed * 0.7 + current * 0.3 };
            last_emit = Instant::now();
            last_done = status.done;
            let _ = app.emit(
                EVENT,
                Event::Progress {
                    id: job.id.clone(),
                    done: status.done,
                    total,
                    speed,
                },
            );
        }
    }
    file.flush().await?;
    drop(file);

    if let Some(total) = total {
        if status.done != total {
            return Err(Stop::Failed(format!(
                "Connection ended early: got {} of {total} bytes",
                status.done
            )));
        }
    }
    finish(&path).await
}

/// Move the finished `.part` into place, without overwriting something that appeared meanwhile.
async fn finish(path: &Path) -> Result<PathBuf, Stop> {
    let target = free_path(path).await;
    tokio::fs::rename(part_path(path), &target).await?;
    Ok(target)
}

async fn send(
    client: &Client,
    job: &Job,
    from: u64,
    signal: &mut watch::Receiver<Signal>,
) -> Result<Response, Stop> {
    // Compressed bodies would break byte offsets.
    let mut request = client.get(&job.url).header(header::ACCEPT_ENCODING, "identity");
    if let Some(referer) = job.referer.as_deref() {
        request = request.header(header::REFERER, referer);
    }
    if let Some(user_agent) = job.user_agent.as_deref() {
        request = request.header(header::USER_AGENT, user_agent);
    }
    if from > 0 {
        request = request.header(header::RANGE, format!("bytes={from}-"));
        if let Some(validator) = job.validator.as_deref().filter(|value| !value.starts_with("W/")) {
            request = request.header(header::IF_RANGE, validator);
        }
    }
    tokio::select! {
        response = request.send() => response.map_err(|error| Stop::Failed(describe(&error))),
        stop = stopped(signal) => Err(stop),
    }
}

pub async fn stopped(signal: &mut watch::Receiver<Signal>) -> Stop {
    match signal.wait_for(|value| *value != Signal::Run).await.map(|value| *value) {
        Ok(Signal::Pause) => Stop::Paused,
        // Only a dropped sender gets past the wait otherwise, and the sender outlives us.
        _ => Stop::Cancelled,
    }
}

fn describe(error: &tauri_plugin_http::reqwest::Error) -> String {
    if error.is_timeout() {
        "The server stopped responding".into()
    } else if error.is_connect() {
        "Can't reach the server".into()
    } else {
        error.to_string()
    }
}

fn is_expired_status(status: StatusCode) -> bool {
    matches!(status.as_u16(), 401 | 403 | 404 | 410)
}

fn http_error(status: StatusCode) -> String {
    if is_expired_status(status) {
        format!("HTTP {}: the link may have expired. Open it again from Home", status.as_u16())
    } else {
        format!("HTTP {}", status.as_u16())
    }
}

fn part_path(path: &Path) -> PathBuf {
    let mut name = OsString::from(path.as_os_str());
    name.push(".part");
    PathBuf::from(name)
}

async fn open_part(part: &Path, from: u64) -> Result<tokio::fs::File, Stop> {
    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(part)
        .await?;
    file.set_len(from).await?;
    file.seek(std::io::SeekFrom::End(0)).await?;
    Ok(file)
}

/// Claim a name no other file or download is using.
async fn create_unique(folder: &Path, name: &str) -> Result<(PathBuf, tokio::fs::File), Stop> {
    for attempt in 0..10_000 {
        let path = folder.join(numbered(name, attempt));
        if tokio::fs::try_exists(&path).await? {
            continue;
        }
        let opened = tokio::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(part_path(&path))
            .await;
        match opened {
            Ok(file) => return Ok((path, file)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.into()),
        }
    }
    Err(Stop::Failed(format!("Too many files named {name}")))
}

pub async fn free_path(path: &Path) -> PathBuf {
    let name = path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
    let folder = path.parent().unwrap_or(Path::new(""));
    for attempt in 0..10_000 {
        let candidate = folder.join(numbered(&name, attempt));
        if !tokio::fs::try_exists(&candidate).await.unwrap_or(false) {
            return candidate;
        }
    }
    path.to_path_buf()
}

/// `film.mkv`, `film (1).mkv`, `film (2).mkv`...
pub fn numbered(name: &str, attempt: u32) -> String {
    if attempt == 0 {
        return name.to_string();
    }
    match name.rfind('.') {
        Some(dot) if dot > 0 => format!("{} ({attempt}){}", &name[..dot], &name[dot..]),
        _ => format!("{name} ({attempt})"),
    }
}

fn continues_at(response: &Response, from: u64, validator: Option<&str>) -> bool {
    response.status() == StatusCode::PARTIAL_CONTENT
        && content_range(response).map(|(start, _)| start) == Some(from)
        && match (validator, validator_of(response.headers())) {
            (Some(old), Some(new)) => old == new,
            _ => true,
        }
}

/// Start and total size from `Content-Range: bytes 100-999/1000` or `bytes */1000`.
fn content_range(response: &Response) -> Option<(u64, Option<u64>)> {
    parse_content_range(response.headers().get(header::CONTENT_RANGE)?.to_str().ok()?)
}

fn parse_content_range(value: &str) -> Option<(u64, Option<u64>)> {
    let (range, total) = value.strip_prefix("bytes ")?.split_once('/')?;
    let start = range.split_once('-').and_then(|(start, _)| start.parse().ok()).unwrap_or(0);
    Some((start, total.parse().ok()))
}

fn total_size(response: &Response, from: u64) -> Option<u64> {
    if response.status() == StatusCode::PARTIAL_CONTENT {
        if let Some(total) = content_range(response).and_then(|(_, total)| total) {
            return Some(total);
        }
    }
    let length = response
        .headers()
        .get(header::CONTENT_LENGTH)?
        .to_str()
        .ok()?
        .parse::<u64>()
        .ok()?;
    Some(from + length)
}

fn validator_of(headers: &header::HeaderMap) -> Option<String> {
    let value = headers.get(header::ETAG).or_else(|| headers.get(header::LAST_MODIFIED))?;
    value.to_str().ok().map(str::to_string)
}

fn is_page(headers: &header::HeaderMap) -> bool {
    let text = |name| headers.get(name).and_then(|value: &header::HeaderValue| value.to_str().ok());
    let attachment = text(header::CONTENT_DISPOSITION)
        .is_some_and(|value| value.trim_start().to_lowercase().starts_with("attachment"));
    !attachment && text(header::CONTENT_TYPE).is_some_and(|value| value.to_lowercase().contains("html"))
}

fn choose_name(headers: &header::HeaderMap, url: &Url, fallback: &str) -> String {
    let from_header = headers
        .get(header::CONTENT_DISPOSITION)
        .and_then(|value| value.to_str().ok())
        .and_then(disposition_name);
    let chosen = from_header
        .or_else(|| url_name(url))
        .map(|name| sanitize(&name))
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| sanitize(fallback));
    let name = if chosen.is_empty() { "download".to_string() } else { chosen };
    if name.contains('.') {
        return name;
    }
    let content_type = headers.get(header::CONTENT_TYPE).and_then(|value| value.to_str().ok());
    match content_type.and_then(extension_for) {
        Some(extension) => format!("{name}.{extension}"),
        None => name,
    }
}

/// The name we were told to use, with an extension for the kind of file it turned out to be.
fn exact_name(headers: &header::HeaderMap, name: &str) -> String {
    let safe = sanitize(name);
    let safe = if safe.is_empty() { "download".to_string() } else { safe };
    let content_type = headers.get(header::CONTENT_TYPE).and_then(|value| value.to_str().ok());
    // These links are to videos, and servers sometimes only say "binary".
    let extension = content_type.and_then(extension_for).unwrap_or("mp4");
    if safe.to_ascii_lowercase().ends_with(&format!(".{extension}")) {
        safe
    } else {
        shorten(&format!("{safe}.{extension}"))
    }
}

fn disposition_name(value: &str) -> Option<String> {
    let lower = value.to_ascii_lowercase();
    if let Some(at) = lower.find("filename*=") {
        let rest = &value[at + "filename*=".len()..];
        let rest = rest.split(';').next().unwrap_or(rest).trim();
        if let Some((_, encoded)) = rest.split_once("''") {
            let decoded = percent_decode_str(encoded.trim_matches('"')).decode_utf8_lossy();
            if !decoded.is_empty() {
                return Some(decoded.into_owned());
            }
        }
    }
    let at = lower.find("filename=")?;
    let rest = value[at + "filename=".len()..].trim_start();
    let name = match rest.strip_prefix('"') {
        Some(quoted) => quoted.split('"').next().unwrap_or(quoted),
        None => rest.split(';').next().unwrap_or(rest).trim(),
    };
    (!name.is_empty()).then(|| name.to_string())
}

fn url_name(url: &Url) -> Option<String> {
    let last = url.path_segments()?.rev().find(|segment| !segment.is_empty())?;
    Some(percent_decode_str(last).decode_utf8_lossy().into_owned())
}

fn extension_for(content_type: &str) -> Option<&'static str> {
    let essence = content_type.split(';').next()?.trim().to_ascii_lowercase();
    Some(match essence.as_str() {
        "video/mp4" => "mp4",
        "video/x-matroska" => "mkv",
        "video/webm" => "webm",
        "video/quicktime" => "mov",
        "video/x-msvideo" => "avi",
        "video/mp2t" => "ts",
        "audio/mpeg" => "mp3",
        "audio/mp4" => "m4a",
        "audio/flac" => "flac",
        "application/zip" => "zip",
        "application/pdf" => "pdf",
        _ => return None,
    })
}

/// Servers choose names, so nothing in one may lead outside the download folder.
pub fn sanitize(name: &str) -> String {
    // A name with separators keeps only its last part.
    let last = name.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = last
        .chars()
        .map(|c| if c.is_control() || matches!(c, ':' | '*' | '?' | '"' | '<' | '>' | '|') { '_' } else { c })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim();
    let stem = trimmed.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.as_bytes()[3].is_ascii_digit());
    let safe = if reserved { format!("_{trimmed}") } else { trimmed.to_string() };
    shorten(&safe)
}

/// Fit the file system's name limit, keeping the extension and room for ` (1).part`.
fn shorten(name: &str) -> String {
    if name.len() <= MAX_NAME_BYTES {
        return name.to_string();
    }
    let extension = name.rfind('.').map_or("", |dot| &name[dot..]);
    let extension = if extension.len() > 16 { "" } else { extension };
    let mut end = MAX_NAME_BYTES - extension.len();
    while !name.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}{extension}", &name[..end])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(header::HeaderName, &str)]) -> header::HeaderMap {
        pairs
            .iter()
            .map(|(name, value)| (name.clone(), header::HeaderValue::from_str(value).unwrap()))
            .collect()
    }

    #[test]
    fn sanitize_cannot_leave_the_folder() {
        assert_eq!(sanitize("../../etc/passwd"), "passwd");
        assert_eq!(sanitize("..\\..\\windows\\evil.exe"), "evil.exe");
        assert_eq!(sanitize("/abs/film.mkv"), "film.mkv");
        assert_eq!(sanitize(".."), "");
        assert_eq!(sanitize("."), "");
        assert_eq!(sanitize("dir/"), "");
        assert_eq!(sanitize(".hidden"), "hidden");
    }

    #[test]
    fn sanitize_replaces_characters_disks_refuse() {
        assert_eq!(sanitize("a:b*c?.mkv"), "a_b_c_.mkv");
        assert_eq!(sanitize("line\nbreak.mp4"), "line_break.mp4");
        assert_eq!(sanitize("CON.txt"), "_CON.txt");
        assert_eq!(sanitize("com1"), "_com1");
        assert_eq!(sanitize("console.txt"), "console.txt");
    }

    #[test]
    fn long_names_keep_their_extension_and_stay_valid_utf8() {
        let name = sanitize(&format!("{}.mkv", "é".repeat(300)));
        assert!(name.len() <= MAX_NAME_BYTES);
        assert!(name.ends_with(".mkv"));
    }

    #[test]
    fn reads_names_from_content_disposition() {
        assert_eq!(disposition_name(r#"attachment; filename="a b.mkv""#).unwrap(), "a b.mkv");
        assert_eq!(disposition_name("attachment; filename=a.mkv; size=3").unwrap(), "a.mkv");
        assert_eq!(
            disposition_name(r#"attachment; filename="x.mkv"; filename*=UTF-8''caf%C3%A9.mkv"#).unwrap(),
            "café.mkv"
        );
        assert_eq!(disposition_name(r#"ATTACHMENT; FILENAME="u.mkv""#).unwrap(), "u.mkv");
        assert_eq!(disposition_name("attachment"), None);
    }

    #[test]
    fn chooses_header_then_url_then_fallback() {
        let url = Url::parse("https://cdn.io/dir/my%20film.mkv?token=1").unwrap();
        let bare = Url::parse("https://cdn.io/").unwrap();
        let named = headers(&[(header::CONTENT_DISPOSITION, "attachment; filename=\"../h.mp4\"")]);
        assert_eq!(choose_name(&named, &url, "x"), "h.mp4");
        assert_eq!(choose_name(&header::HeaderMap::new(), &url, "x"), "my film.mkv");
        assert_eq!(choose_name(&header::HeaderMap::new(), &bare, "Opt/1"), "1");
        assert_eq!(choose_name(&header::HeaderMap::new(), &bare, ".."), "download");
    }

    #[test]
    fn adds_an_extension_from_the_type_when_missing() {
        let url = Url::parse("https://cdn.io/blob").unwrap();
        let typed = headers(&[(header::CONTENT_TYPE, "video/x-matroska; x=1")]);
        assert_eq!(choose_name(&typed, &url, "x"), "blob.mkv");
        let unknown = headers(&[(header::CONTENT_TYPE, "application/octet-stream")]);
        assert_eq!(choose_name(&unknown, &url, "x"), "blob");
    }

    #[test]
    fn an_exact_name_ignores_the_address_and_server() {
        let typed = headers(&[
            (header::CONTENT_TYPE, "video/x-matroska"),
            (header::CONTENT_DISPOSITION, "attachment; filename=\"ads.exe\""),
        ]);
        assert_eq!(exact_name(&typed, "Wall-e"), "Wall-e.mkv");
        assert_eq!(exact_name(&typed, "Wall-e.mkv"), "Wall-e.mkv");
        assert_eq!(exact_name(&typed, "../../Ep. 1"), "Ep. 1.mkv");
        assert_eq!(exact_name(&headers(&[(header::CONTENT_TYPE, "video/mp4")]), "a › b"), "a › b.mp4");
        let vague = headers(&[(header::CONTENT_TYPE, "application/octet-stream")]);
        assert_eq!(exact_name(&vague, "Film"), "Film.mp4");
        assert_eq!(exact_name(&header::HeaderMap::new(), ".."), "download.mp4");
    }

    #[test]
    fn numbers_duplicates_before_the_extension() {
        assert_eq!(numbered("a.mkv", 0), "a.mkv");
        assert_eq!(numbered("a.mkv", 2), "a (2).mkv");
        assert_eq!(numbered("plain", 1), "plain (1)");
    }

    #[test]
    fn parses_content_range() {
        assert_eq!(parse_content_range("bytes 100-999/1000"), Some((100, Some(1000))));
        assert_eq!(parse_content_range("bytes 100-999/*"), Some((100, None)));
        assert_eq!(parse_content_range("bytes */1000"), Some((0, Some(1000))));
        assert_eq!(parse_content_range("nonsense"), None);
    }

    #[test]
    fn a_page_is_only_a_page_unless_sent_as_attachment() {
        assert!(is_page(&headers(&[(header::CONTENT_TYPE, "text/html; charset=utf-8")])));
        assert!(!is_page(&headers(&[(header::CONTENT_TYPE, "video/mp4")])));
        assert!(!is_page(&headers(&[
            (header::CONTENT_TYPE, "text/html"),
            (header::CONTENT_DISPOSITION, "attachment; filename=a.bin"),
        ])));
    }
}
