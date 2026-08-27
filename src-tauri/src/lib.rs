mod document;
mod open_requests;
mod watch;

use open_requests::{dispatch_or_queue, OpenRequestState};
use std::path::Path;
use tauri::Manager;
use watch::WatchState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(OpenRequestState::default())
        .manage(WatchState::default())
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            for argument in args.into_iter().skip(1) {
                dispatch_or_queue(app, Path::new(&argument));
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            document::read_document,
            document::read_local_image,
            open_requests::take_pending_open,
            watch::watch_document,
        ])
        .setup(|app| {
            for argument in std::env::args_os().skip(1) {
                dispatch_or_queue(app.handle(), Path::new(&argument));
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build FFM Viewer");

    app.run(|app, event| {
        if let tauri::RunEvent::Opened { urls } = event {
            for url in urls {
                if let Ok(path) = url.to_file_path() {
                    dispatch_or_queue(app, &path);
                }
            }
        }
    });
}
