//! The programs stream downloads depend on. They aren't part of the install: the setup panel
//! fetches the latest release of each into the app's data folder, because install folders
//! are usually read-only.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_http::reqwest::{header, Client, StatusCode};
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;

use crate::media;
use crate::transfers::{Transfers, PROGRESS_EVERY};

const EVENT: &str = "dependency";
const MANIFEST: &str = "installed.json";
const RELEASES: &str = "https://api.github.com/repos";
/// Long enough for yt-dlp to unpack itself on a slow disk.
const TEST_RUN_TIMEOUT: Duration = Duration::from_secs(120);

pub const YT_DLP: &str = "yt-dlp";
pub const FFMPEG: &str = "ffmpeg";
const ALL: [&str; 2] = [YT_DLP, FFMPEG];

#[derive(Clone, Copy, Debug, PartialEq)]
enum Packaging {
    /// The asset is the program.
    Plain,
    TarXz,
    Zip,
}

#[derive(Debug, PartialEq)]
struct Source {
    repo: &'static str,
    asset: &'static str,
    packaging: Packaging,
    /// The argument that makes it print its version and quit.
    version_argument: &'static str,
}

/// Where each program comes from on each system. None where it isn't published.
fn source_for(id: &str, os: &str, arch: &str) -> Option<Source> {
    let (repo, asset, packaging, version_argument) = match (id, os, arch) {
        (YT_DLP, "linux", "x86_64") => ("yt-dlp/yt-dlp", "yt-dlp_linux", Packaging::Plain, "--version"),
        (YT_DLP, "linux", "aarch64") => ("yt-dlp/yt-dlp", "yt-dlp_linux_aarch64", Packaging::Plain, "--version"),
        (YT_DLP, "windows", "x86_64") => ("yt-dlp/yt-dlp", "yt-dlp.exe", Packaging::Plain, "--version"),
        (YT_DLP, "windows", "aarch64") => ("yt-dlp/yt-dlp", "yt-dlp_arm64.exe", Packaging::Plain, "--version"),
        (YT_DLP, "macos", _) => ("yt-dlp/yt-dlp", "yt-dlp_macos", Packaging::Plain, "--version"),
        (FFMPEG, "linux", "x86_64") => (
            "BtbN/FFmpeg-Builds",
            "ffmpeg-master-latest-linux64-lgpl.tar.xz",
            Packaging::TarXz,
            "-version",
        ),
        (FFMPEG, "linux", "aarch64") => (
            "BtbN/FFmpeg-Builds",
            "ffmpeg-master-latest-linuxarm64-lgpl.tar.xz",
            Packaging::TarXz,
            "-version",
        ),
        (FFMPEG, "windows", "x86_64") => (
            "BtbN/FFmpeg-Builds",
            "ffmpeg-master-latest-win64-lgpl.zip",
            Packaging::Zip,
            "-version",
        ),
        (FFMPEG, "windows", "aarch64") => (
            "BtbN/FFmpeg-Builds",
            "ffmpeg-master-latest-winarm64-lgpl.zip",
            Packaging::Zip,
            "-version",
        ),
        (FFMPEG, "macos", "aarch64") => (
            "eugeneware/ffmpeg-static",
            "ffmpeg-darwin-arm64",
            Packaging::Plain,
            "-version",
        ),
        (FFMPEG, "macos", "x86_64") => (
            "eugeneware/ffmpeg-static",
            "ffmpeg-darwin-x64",
            Packaging::Plain,
            "-version",
        ),
        _ => return None,
    };
    Some(Source { repo, asset, packaging, version_argument })
}

fn source(id: &str) -> Result<Source, String> {
    source_for(id, std::env::consts::OS, std::env::consts::ARCH)
        .ok_or_else(|| format!("{id} isn't available for this system"))
}

#[derive(Default)]
pub struct Dependencies {
    installing: Mutex<HashSet<String>>,
    /// Two installs finishing together must not overwrite each other's record.
    manifest: Mutex<()>,
}

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    published_at: Option<String>,
    assets: Vec<Asset>,
}

#[derive(Debug, Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
    digest: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
struct Installed {
    version: String,
    /// The asset's checksum, which is what tells builds under a rolling tag apart.
    digest: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyStatus {
    id: &'static str,
    installed: bool,
    version: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LatestVersion {
    id: &'static str,
    version: String,
    update_available: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress<'a> {
    id: &'a str,
    stage: &'static str,
    done: u64,
    total: Option<u64>,
}

fn folder(app: &AppHandle) -> Result<PathBuf, String> {
    let data = app.path().app_data_dir().map_err(|error| error.to_string())?;
    Ok(data.join("bin"))
}

fn file_name(id: &str) -> String {
    format!("{id}{}", std::env::consts::EXE_SUFFIX)
}

/// Where an installed program is, to run it.
pub fn executable(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    let path = folder(app)?.join(file_name(id));
    if path.is_file() {
        Ok(path)
    } else {
        Err(format!("{id} is missing. Install it in Settings"))
    }
}

async fn read_manifest(folder: &Path) -> HashMap<String, Installed> {
    let Ok(text) = tokio::fs::read(folder.join(MANIFEST)).await else {
        return HashMap::new();
    };
    serde_json::from_slice(&text).unwrap_or_default()
}

/// What's installed. Doesn't touch the network.
#[tauri::command]
pub async fn deps_status(app: AppHandle) -> Result<Vec<DependencyStatus>, String> {
    let folder = folder(&app)?;
    let manifest = read_manifest(&folder).await;
    let mut list = Vec::new();
    for id in ALL {
        let record = manifest.get(id);
        let present = tokio::fs::try_exists(folder.join(file_name(id))).await.unwrap_or(false);
        list.push(DependencyStatus {
            id,
            installed: present && record.is_some(),
            version: record.map(|record| record.version.clone()),
        });
    }
    Ok(list)
}

/// Ask GitHub what the latest of each is.
#[tauri::command]
pub async fn deps_check(app: AppHandle, transfers: State<'_, Transfers>) -> Result<Vec<LatestVersion>, String> {
    let manifest = read_manifest(&folder(&app)?).await;
    let client = transfers.client();
    let mut list = Vec::new();
    for id in ALL {
        let source = source(id)?;
        let release = latest_release(&client, source.repo).await?;
        let asset = find_asset(&release, source.asset)?;
        let digest = sha256_of(asset)?;
        list.push(LatestVersion {
            id,
            version: version_label(&release),
            update_available: manifest.get(id).is_none_or(|record| record.digest != digest),
        });
    }
    Ok(list)
}

/// Install or update one program, reporting progress as `dependency` events.
#[tauri::command]
pub async fn deps_install(
    app: AppHandle,
    state: State<'_, Dependencies>,
    transfers: State<'_, Transfers>,
    id: String,
) -> Result<DependencyStatus, String> {
    let id = ALL
        .into_iter()
        .find(|known| *known == id)
        .ok_or_else(|| format!("Unknown dependency: {id}"))?;
    if !state.installing.lock().await.insert(id.to_string()) {
        return Err(format!("{id} is already being installed"));
    }
    let result = install(&app, &state, &transfers, id).await;
    state.installing.lock().await.remove(id);
    result
}

async fn install(
    app: &AppHandle,
    state: &Dependencies,
    transfers: &Transfers,
    id: &'static str,
) -> Result<DependencyStatus, String> {
    let folder = folder(app)?;
    let source = source(id)?;
    let client = transfers.client();
    tokio::fs::create_dir_all(&folder)
        .await
        .map_err(|error| format!("Can't create {}: {error}", folder.display()))?;

    let emit = |stage, done, total| {
        let _ = app.emit_to("main", EVENT, Progress { id, stage, done, total });
    };
    emit("downloading", 0, None);
    let release = latest_release(&client, source.repo).await?;
    let asset = find_asset(&release, source.asset)?;
    let digest = sha256_of(asset)?;

    let download = folder.join(format!(".{id}.download"));
    let prepared = folder.join(format!(".{id}.new{}", std::env::consts::EXE_SUFFIX));
    let result = async {
        fetch_verified(&client, &asset.browser_download_url, &digest, &download, &emit).await?;
        emit("installing", 0, None);
        unpack(source.packaging, id, &download, &prepared).await?;
        make_runnable(&prepared).await?;
        test_run(&prepared, source.version_argument, id).await?;

        // Windows can't replace a program that's running.
        if transfers.has_processes() && tokio::fs::try_exists(folder.join(file_name(id))).await.unwrap_or(false) {
            return Err("Pause or finish stream downloads, then try again".to_string());
        }
        tokio::fs::rename(&prepared, folder.join(file_name(id)))
            .await
            .map_err(|error| format!("Couldn't save {id}: {error}"))
    }
    .await;
    let _ = tokio::fs::remove_file(&download).await;
    let _ = tokio::fs::remove_file(&prepared).await;
    result?;

    let version = version_label(&release);
    let _guard = state.manifest.lock().await;
    let mut manifest = read_manifest(&folder).await;
    manifest.insert(id.to_string(), Installed { version: version.clone(), digest });
    let text = serde_json::to_vec_pretty(&manifest).map_err(|error| error.to_string())?;
    let temporary = folder.join(format!(".{MANIFEST}.new"));
    tokio::fs::write(&temporary, text).await.map_err(|error| error.to_string())?;
    tokio::fs::rename(&temporary, folder.join(MANIFEST))
        .await
        .map_err(|error| error.to_string())?;
    Ok(DependencyStatus { id, installed: true, version: Some(version) })
}

/// Tests can point this at a local server. A release build always asks GitHub.
fn releases_address(repo: &str) -> String {
    #[cfg(debug_assertions)]
    if let Ok(base) = std::env::var("STREM_DL_RELEASES_URL") {
        return format!("{base}/{repo}/releases/latest");
    }
    format!("{RELEASES}/{repo}/releases/latest")
}

async fn latest_release(client: &Client, repo: &str) -> Result<Release, String> {
    let response = client
        .get(releases_address(repo))
        .header(header::ACCEPT, "application/vnd.github+json")
        .send()
        .await
        .map_err(|error| format!("Can't reach GitHub: {error}"))?;
    let status = response.status();
    if status == StatusCode::FORBIDDEN || status == StatusCode::TOO_MANY_REQUESTS {
        return Err("GitHub is limiting requests from this address. Try again in a while".into());
    }
    if !status.is_success() {
        return Err(format!("GitHub answered HTTP {} for {repo}", status.as_u16()));
    }
    let body = response
        .bytes()
        .await
        .map_err(|error| format!("Couldn't read the release of {repo}: {error}"))?;
    serde_json::from_slice(&body).map_err(|error| format!("Couldn't read the release of {repo}: {error}"))
}

fn find_asset<'a>(release: &'a Release, name: &str) -> Result<&'a Asset, String> {
    release
        .assets
        .iter()
        .find(|asset| asset.name == name)
        .ok_or_else(|| format!("The latest release has no {name}"))
}

/// A release must state its checksum, or there's nothing to verify the download against.
fn sha256_of(asset: &Asset) -> Result<String, String> {
    asset
        .digest
        .as_deref()
        .and_then(|digest| digest.strip_prefix("sha256:"))
        .filter(|hex| hex.len() == 64 && hex.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| format!("{} has no published checksum, so it can't be verified", asset.name))
}

/// Rolling tags like `latest` mean nothing to read, so those show the release's date.
fn version_label(release: &Release) -> String {
    if release.tag_name != "latest" {
        return release.tag_name.clone();
    }
    release
        .published_at
        .as_deref()
        .and_then(|date| date.split('T').next())
        .unwrap_or("latest")
        .to_string()
}

async fn fetch_verified(
    client: &Client,
    url: &str,
    digest: &str,
    path: &Path,
    emit: &impl Fn(&'static str, u64, Option<u64>),
) -> Result<(), String> {
    let lost = |error: tauri_plugin_http::reqwest::Error| format!("The download failed: {error}");
    let mut response = client.get(url).send().await.map_err(lost)?;
    if !response.status().is_success() {
        return Err(format!("The download failed: HTTP {}", response.status().as_u16()));
    }
    let total = response.content_length();
    let mut file = tokio::fs::File::create(path).await.map_err(|error| error.to_string())?;
    let mut hash = Sha256::new();
    let mut done = 0;
    let mut last_emit = Instant::now();
    while let Some(chunk) = response.chunk().await.map_err(lost)? {
        file.write_all(&chunk).await.map_err(|error| error.to_string())?;
        hash.update(&chunk);
        done += chunk.len() as u64;
        if last_emit.elapsed() >= PROGRESS_EVERY {
            last_emit = Instant::now();
            emit("downloading", done, total);
        }
    }
    file.flush().await.map_err(|error| error.to_string())?;
    emit("downloading", done, total);

    let actual = format!("{:x}", hash.finalize());
    if actual != digest {
        return Err(format!("The download doesn't match its published checksum (got {actual})"));
    }
    Ok(())
}

async fn unpack(packaging: Packaging, id: &str, download: &Path, prepared: &Path) -> Result<(), String> {
    let member = file_name(id);
    let download = download.to_path_buf();
    let prepared = prepared.to_path_buf();
    tauri::async_runtime::spawn_blocking(move || match packaging {
        Packaging::Plain => std::fs::copy(&download, &prepared)
            .map(|_| ())
            .map_err(|error| error.to_string()),
        Packaging::TarXz => extract_tar_xz(&download, &member, &prepared),
        Packaging::Zip => extract_zip(&download, &member, &prepared),
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Only ever copies the one named program, to our own path: nothing in an archive picks a location.
fn extract_tar_xz(archive: &Path, member: &str, output: &Path) -> Result<(), String> {
    let file = File::open(archive).map_err(|error| error.to_string())?;
    let mut tar = tar::Archive::new(xz2::read::XzDecoder::new(file));
    let unreadable = |error: std::io::Error| format!("Couldn't unpack the download: {error}");
    for entry in tar.entries().map_err(unreadable)? {
        let mut entry = entry.map_err(unreadable)?;
        let matches = entry.header().entry_type().is_file()
            && entry.path().map_err(unreadable)?.file_name().is_some_and(|name| name == member);
        if matches {
            let mut out = File::create(output).map_err(|error| error.to_string())?;
            std::io::copy(&mut entry, &mut out).map_err(unreadable)?;
            return Ok(());
        }
    }
    Err(format!("The download doesn't contain {member}"))
}

fn extract_zip(archive: &Path, member: &str, output: &Path) -> Result<(), String> {
    let file = File::open(archive).map_err(|error| error.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|error| format!("Couldn't unpack the download: {error}"))?;
    for index in 0..zip.len() {
        let mut entry = zip.by_index(index).map_err(|error| format!("Couldn't unpack the download: {error}"))?;
        if entry.is_file() && entry.name().rsplit('/').next() == Some(member) {
            let mut out = File::create(output).map_err(|error| error.to_string())?;
            std::io::copy(&mut entry, &mut out).map_err(|error| format!("Couldn't unpack the download: {error}"))?;
            return Ok(());
        }
    }
    Err(format!("The download doesn't contain {member}"))
}

async fn make_runnable(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
            .await
            .map_err(|error| error.to_string())?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

/// Before it replaces anything: a program that can't run here is no use.
async fn test_run(path: &Path, argument: &str, id: &str) -> Result<(), String> {
    let mut command = media::command(path);
    command.arg(argument).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    let failed = |reason: String| format!("{id} doesn't run on this system: {reason}");
    let mut child = command.spawn().map_err(|error| failed(error.to_string()))?;
    match tokio::time::timeout(TEST_RUN_TIMEOUT, child.wait()).await {
        Ok(Ok(status)) if status.success() => Ok(()),
        Ok(Ok(status)) => Err(failed(status.to_string())),
        Ok(Err(error)) => Err(failed(error.to_string())),
        Err(_) => Err(failed("it didn't respond".into())),
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use super::*;

    fn asset(name: &str, digest: Option<&str>) -> Asset {
        Asset {
            name: name.into(),
            browser_download_url: format!("https://example.test/{name}"),
            digest: digest.map(str::to_string),
        }
    }

    fn scratch(name: &str) -> PathBuf {
        let folder = std::env::temp_dir().join(format!("strem-dl-deps-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&folder).unwrap();
        folder
    }

    #[test]
    fn every_supported_system_has_both_programs() {
        for (os, arch) in [
            ("linux", "x86_64"),
            ("linux", "aarch64"),
            ("windows", "x86_64"),
            ("windows", "aarch64"),
            ("macos", "x86_64"),
            ("macos", "aarch64"),
        ] {
            for id in ALL {
                assert!(source_for(id, os, arch).is_some(), "{id} on {os} {arch}");
            }
        }
        assert_eq!(source_for(FFMPEG, "freebsd", "x86_64"), None);
        assert_eq!(source_for("other", "linux", "x86_64"), None);
    }

    #[test]
    fn avoids_the_linux_ffmpeg_build_that_crashes() {
        for arch in ["x86_64", "aarch64"] {
            assert_eq!(source_for(FFMPEG, "linux", arch).unwrap().repo, "BtbN/FFmpeg-Builds");
        }
    }

    #[test]
    fn a_download_needs_a_checksum_to_verify_against() {
        let hex = "A".repeat(64);
        let good = asset("a", Some(&format!("sha256:{hex}")));
        assert_eq!(sha256_of(&good).unwrap(), "a".repeat(64));
        for bad in [None, Some("md5:abc"), Some("sha256:short"), Some("sha256:zz")] {
            assert!(sha256_of(&asset("a", bad)).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn rolling_releases_show_their_date() {
        let release = |tag: &str| Release {
            tag_name: tag.into(),
            published_at: Some("2026-11-02T13:12:39Z".into()),
            assets: vec![],
        };
        assert_eq!(version_label(&release("2026.10.26")), "2026.10.26");
        assert_eq!(version_label(&release("latest")), "2026-11-02");
    }

    #[test]
    fn reports_a_missing_asset() {
        let release = Release {
            tag_name: "1".into(),
            published_at: None,
            assets: vec![asset("other", None)],
        };
        assert!(find_asset(&release, "wanted").unwrap_err().contains("wanted"));
        assert!(find_asset(&release, "other").is_ok());
    }

    #[test]
    fn unpacks_only_the_named_program_from_a_tar_xz() {
        let folder = scratch("tar");
        let archive = folder.join("a.tar.xz");
        {
            let encoder = xz2::write::XzEncoder::new(File::create(&archive).unwrap(), 1);
            let mut tar = tar::Builder::new(encoder);
            for (path, content) in [("a/bin/ffplay", &b"no"[..]), ("a/bin/ffmpeg", &b"yes"[..])] {
                let mut header = tar::Header::new_gnu();
                header.set_size(content.len() as u64);
                header.set_mode(0o755);
                header.set_cksum();
                tar.append_data(&mut header, path, content).unwrap();
            }
            tar.into_inner().unwrap().finish().unwrap();
        }
        let output = folder.join("out");
        extract_tar_xz(&archive, "ffmpeg", &output).unwrap();
        assert_eq!(std::fs::read(&output).unwrap(), b"yes");
        assert!(extract_tar_xz(&archive, "absent", &output).unwrap_err().contains("absent"));
        std::fs::remove_dir_all(folder).unwrap();
    }

    #[test]
    fn unpacks_only_the_named_program_from_a_zip() {
        let folder = scratch("zip");
        let archive = folder.join("a.zip");
        {
            let mut zip = zip::ZipWriter::new(File::create(&archive).unwrap());
            let options = zip::write::SimpleFileOptions::default();
            for (path, content) in [("a/bin/ffplay.exe", &b"no"[..]), ("a/bin/ffmpeg.exe", &b"yes"[..])] {
                zip.start_file(path, options).unwrap();
                zip.write_all(content).unwrap();
            }
            zip.finish().unwrap();
        }
        let output = folder.join("out.exe");
        extract_zip(&archive, "ffmpeg.exe", &output).unwrap();
        assert_eq!(std::fs::read(&output).unwrap(), b"yes");
        assert!(extract_zip(&archive, "absent", &output).is_err());
        std::fs::remove_dir_all(folder).unwrap();
    }

    #[test]
    fn a_damaged_archive_is_an_error_not_a_crash() {
        let folder = scratch("bad");
        let archive = folder.join("bad");
        std::fs::write(&archive, b"not an archive").unwrap();
        assert!(extract_tar_xz(&archive, "ffmpeg", &folder.join("o1")).is_err());
        assert!(extract_zip(&archive, "ffmpeg", &folder.join("o2")).is_err());
        std::fs::remove_dir_all(folder).unwrap();
    }

    #[tokio::test]
    async fn a_program_that_cannot_run_is_refused() {
        let folder = scratch("run");
        let bad = folder.join("bad");
        std::fs::write(&bad, b"not a program").unwrap();
        make_runnable(&bad).await.unwrap();
        assert!(test_run(&bad, "--version", "x").await.unwrap_err().contains("doesn't run"));
        std::fs::remove_dir_all(folder).unwrap();
    }
}
