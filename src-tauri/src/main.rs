#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod capture;
mod deps;
mod media;
mod reveal;
mod transfers;

use tauri::{Manager, RunEvent, WindowEvent};
use tauri_plugin_sql::{Migration, MigrationKind};

fn main() {
    let migrations = vec![
        Migration {
            version: 1,
            description: "create favorites and url history",
            sql: include_str!("../migrations/001_init.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "create watchlist",
            sql: include_str!("../migrations/002_watchlist.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "create downloads",
            sql: include_str!("../migrations/003_downloads.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "add download progress and settings",
            sql: include_str!("../migrations/004_transfers_settings.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 5,
            description: "add where a page's video was found",
            sql: include_str!("../migrations/005_media.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 6,
            description: "add other copies of a title",
            sql: include_str!("../migrations/006_copies.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 7,
            description: "add a poster to watched folders",
            sql: include_str!("../migrations/007_watch_poster.sql"),
            kind: MigrationKind::Up,
        },
    ];

    tauri::Builder::default()
        .manage(transfers::Transfers::new())
        .manage(capture::Captures::default())
        .manage(deps::Dependencies::default())
        .invoke_handler(tauri::generate_handler![
            transfers::download_start,
            transfers::download_pause,
            transfers::download_cancel,
            transfers::check_download_folder,
            capture::capture_open,
            capture::capture_show,
            capture::capture_close,
            capture::capture_report,
            media::media_probe,
            deps::deps_status,
            deps::deps_check,
            deps::deps_install,
            reveal::show_in_folder,
        ])
        .on_window_event(|window, event| {
            // A hidden capture window would otherwise keep the app running with no way to quit it.
            if window.label() == "main" && matches!(event, WindowEvent::Destroyed) {
                window.app_handle().exit(0);
            }
        })
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:strem-dl.db", migrations)
                .build(),
        )
        .build(tauri::generate_context!())
        .expect("failed to build the app")
        .run(|app, event| {
            if matches!(event, RunEvent::Exit) {
                app.state::<transfers::Transfers>().kill_processes();
            }
        });
}
