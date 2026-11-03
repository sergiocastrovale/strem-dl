// Listing the app's commands turns on permission checks for them. Each one must also be
// allowed in src-tauri/capabilities/, or nothing can call it.
const COMMANDS: &[&str] = &[
    "download_start",
    "download_pause",
    "download_cancel",
    "check_download_folder",
    "capture_open",
    "capture_show",
    "capture_close",
    "capture_report",
    "media_probe",
    "deps_status",
    "deps_check",
    "deps_install",
    "show_in_folder",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run the Tauri build");
}
