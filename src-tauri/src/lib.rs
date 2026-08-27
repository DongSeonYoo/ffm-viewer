mod document;
mod open_requests;
mod recovery;
mod watch;

use open_requests::{dispatch_or_queue, OpenRequestState};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Emitter, Manager};
use watch::WatchState;

#[derive(Default)]
struct ExitState(AtomicBool);

impl ExitState {
    fn approve_exit(&self) {
        self.0.store(true, Ordering::Release);
    }

    fn should_prevent_exit(&self) -> bool {
        !self.0.load(Ordering::Acquire)
    }
}

#[tauri::command]
fn exit_application(app: tauri::AppHandle, state: tauri::State<'_, ExitState>) {
    state.approve_exit();
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(OpenRequestState::default())
        .manage(WatchState::default())
        .manage(ExitState::default())
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
        .menu(|handle| {
            #[cfg(target_os = "macos")]
            {
                use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu, WINDOW_SUBMENU_ID};
                let close_tab =
                    MenuItem::with_id(handle, "close-tab", "Close Tab", true, Some("CmdOrCtrl+W"))?;
                let quit =
                    MenuItem::with_id(handle, "quit-app", "Quit", true, Some("CmdOrCtrl+Q"))?;
                let app_menu = Submenu::with_items(
                    handle,
                    handle.package_info().name.clone(),
                    true,
                    &[
                        &PredefinedMenuItem::about(handle, None, None)?,
                        &PredefinedMenuItem::separator(handle)?,
                        &PredefinedMenuItem::services(handle, None)?,
                        &PredefinedMenuItem::separator(handle)?,
                        &PredefinedMenuItem::hide(handle, None)?,
                        &PredefinedMenuItem::hide_others(handle, None)?,
                        &PredefinedMenuItem::separator(handle)?,
                        &quit,
                    ],
                )?;
                let file_menu = Submenu::with_items(handle, "File", true, &[&close_tab])?;
                let edit_menu = Submenu::with_items(
                    handle,
                    "Edit",
                    true,
                    &[
                        &PredefinedMenuItem::undo(handle, None)?,
                        &PredefinedMenuItem::redo(handle, None)?,
                        &PredefinedMenuItem::separator(handle)?,
                        &PredefinedMenuItem::cut(handle, None)?,
                        &PredefinedMenuItem::copy(handle, None)?,
                        &PredefinedMenuItem::paste(handle, None)?,
                        &PredefinedMenuItem::select_all(handle, None)?,
                    ],
                )?;
                let view_menu = Submenu::with_items(
                    handle,
                    "View",
                    true,
                    &[&PredefinedMenuItem::fullscreen(handle, None)?],
                )?;
                let window_menu = Submenu::with_id_and_items(
                    handle,
                    WINDOW_SUBMENU_ID,
                    "Window",
                    true,
                    &[
                        &PredefinedMenuItem::minimize(handle, None)?,
                        &PredefinedMenuItem::maximize(handle, None)?,
                    ],
                )?;
                Menu::with_items(
                    handle,
                    &[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu],
                )
            }
            #[cfg(not(target_os = "macos"))]
            tauri::menu::Menu::default(handle)
        })
        .on_menu_event(|app, event| {
            if event.id() == "close-tab" {
                let _ = app.emit("close-active-tab", ());
            } else if event.id() == "quit-app" {
                let _ = app.emit("quit-requested", ());
            }
        })
        .invoke_handler(tauri::generate_handler![
            exit_application,
            document::read_document,
            document::write_document,
            document::read_local_image,
            open_requests::take_pending_open,
            recovery::load_recovery,
            recovery::persist_recovery,
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

    app.run(|app, event| match event {
        tauri::RunEvent::Opened { urls } => {
            for url in urls {
                if let Ok(path) = url.to_file_path() {
                    dispatch_or_queue(app, &path);
                }
            }
        }
        tauri::RunEvent::ExitRequested { api, .. }
            if app.state::<ExitState>().should_prevent_exit() =>
        {
            api.prevent_exit();
            let _ = app.emit("quit-requested", ());
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::ExitState;

    #[test]
    fn external_exit_stays_blocked_until_frontend_approval() {
        let state = ExitState::default();

        assert!(state.should_prevent_exit());
        assert!(state.should_prevent_exit());

        state.approve_exit();

        assert!(!state.should_prevent_exit());
    }
}
