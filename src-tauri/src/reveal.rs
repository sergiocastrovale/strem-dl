//! Shows a saved file in the system's file manager. The opener plugin handles most systems,
//! but on Linux it relies on desktop services that WSL and minimal setups don't have.

use std::path::Path;

#[cfg(target_os = "linux")]
const PATH_VARIABLE: &str = "STREM_DL_REVEAL";

/// The path comes in by variable so that nothing in a file name can be read as PowerShell.
/// Explorer only selects the file if the path alone is in quotes, which needs a raw argument.
#[cfg(target_os = "linux")]
const EXPLORER_SCRIPT: &str =
    "Start-Process explorer.exe -ArgumentList ('/select,' + [char]34 + $env:STREM_DL_REVEAL + [char]34)";

#[cfg(target_os = "linux")]
const POWERSHELL_PATHS: [&str; 2] = [
    "powershell.exe",
    "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
];

#[tauri::command]
pub async fn show_in_folder(path: String) -> Result<(), String> {
    let file = Path::new(&path);
    if !tokio::fs::try_exists(file).await.unwrap_or(false) {
        return Err(format!("This file is no longer at {path}"));
    }

    let target = path.clone();
    let revealed = tauri::async_runtime::spawn_blocking(move || tauri_plugin_opener::reveal_item_in_dir(&target))
        .await
        .map_err(|error| error.to_string())?;
    let Err(_cause) = revealed else {
        return Ok(());
    };

    #[cfg(target_os = "linux")]
    {
        if is_wsl().await && reveal_with_explorer(file).await {
            return Ok(());
        }
        if open_parent_folder(file).await {
            return Ok(());
        }
        Err(format!("No file manager found. The file is at {path}"))
    }
    #[cfg(not(target_os = "linux"))]
    Err(_cause.to_string())
}

#[cfg(target_os = "linux")]
async fn is_wsl() -> bool {
    if std::env::var_os("WSL_DISTRO_NAME").is_some() {
        return true;
    }
    tokio::fs::read_to_string("/proc/version")
        .await
        .is_ok_and(|version| names_wsl(&version))
}

#[cfg(target_os = "linux")]
fn names_wsl(kernel_version: &str) -> bool {
    kernel_version.to_ascii_lowercase().contains("microsoft")
}

/// A command that's free of what an AppImage sets up for itself.
#[cfg(target_os = "linux")]
fn command(program: &str) -> tokio::process::Command {
    use std::process::Stdio;

    let mut command = tokio::process::Command::new(program);
    crate::media::clean_environment(&mut command);
    command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    command
}

#[cfg(target_os = "linux")]
async fn reveal_with_explorer(file: &Path) -> bool {
    use std::process::Stdio;

    let converted = command("wslpath")
        .arg("-w")
        .arg(file)
        .stdout(Stdio::piped())
        .output()
        .await;
    let Ok(converted) = converted else {
        return false;
    };
    let windows_path = String::from_utf8_lossy(&converted.stdout).trim_end().to_string();
    if !converted.status.success() || windows_path.is_empty() {
        return false;
    }

    let shared = shared_variables(std::env::var("WSLENV").ok().as_deref());
    for powershell in POWERSHELL_PATHS {
        let started = command(powershell)
            .args(["-NoProfile", "-NonInteractive", "-Command", EXPLORER_SCRIPT])
            .env(PATH_VARIABLE, &windows_path)
            .env("WSLENV", &shared)
            .status()
            .await;
        if started.is_ok_and(|status| status.success()) {
            return true;
        }
    }
    false
}

/// `WSLENV` lists what crosses over to Windows programs. Others may already be using it.
#[cfg(target_os = "linux")]
fn shared_variables(existing: Option<&str>) -> String {
    match existing {
        Some(list) if !list.is_empty() => format!("{list}:{PATH_VARIABLE}"),
        _ => PATH_VARIABLE.to_string(),
    }
}

/// Can't select the file this way, but it gets you to the right place.
#[cfg(target_os = "linux")]
async fn open_parent_folder(file: &Path) -> bool {
    use std::time::Duration;

    let Some(folder) = file.parent() else {
        return false;
    };
    let Ok(mut child) = command("xdg-open").arg(folder).spawn() else {
        return false;
    };
    // Some setups wait for the file manager to close, and it's open by then.
    match tokio::time::timeout(Duration::from_secs(5), child.wait()).await {
        Ok(status) => status.is_ok_and(|status| status.success()),
        Err(_) => true,
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    #[test]
    fn recognises_wsl_kernels() {
        assert!(names_wsl("Linux version 6.6.87.2-microsoft-standard-WSL2 (root@...)"));
        assert!(names_wsl("Linux version 4.4.0-19041-Microsoft (...)"));
        assert!(!names_wsl("Linux version 6.8.0-45-generic (buildd@ubuntu)"));
    }

    #[test]
    fn adds_to_what_is_already_shared_with_windows() {
        assert_eq!(shared_variables(None), "STREM_DL_REVEAL");
        assert_eq!(shared_variables(Some("")), "STREM_DL_REVEAL");
        assert_eq!(shared_variables(Some("GOPATH/p")), "GOPATH/p:STREM_DL_REVEAL");
    }

    #[test]
    fn the_script_uses_the_variable_and_never_a_path() {
        assert!(EXPLORER_SCRIPT.contains(&format!("$env:{PATH_VARIABLE}")));
    }
}
