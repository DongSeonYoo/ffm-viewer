mod document;
mod open_requests;
mod recovery;
mod search;
mod watch;

use open_requests::{dispatch_or_queue, OpenRequestState};
use search::SearchState;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Emitter, Manager};
use watch::WatchState;

#[derive(Default)]
struct ExitState(AtomicBool);

#[derive(Default)]
struct FileSearchShortcutState {
    ready: AtomicBool,
    pending: AtomicBool,
}

impl FileSearchShortcutState {
    fn request(&self) -> bool {
        if self.ready.load(Ordering::Acquire) {
            return true;
        }
        self.pending.store(true, Ordering::Release);
        self.ready.load(Ordering::Acquire) && self.pending.swap(false, Ordering::AcqRel)
    }

    fn mark_ready(&self) -> bool {
        self.ready.store(true, Ordering::Release);
        self.pending.swap(false, Ordering::AcqRel)
    }
}

impl ExitState {
    fn approve_exit(&self) {
        self.0.store(true, Ordering::Release);
    }

    fn should_prevent_exit(&self) -> bool {
        !self.0.load(Ordering::Acquire)
    }
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg(target_os = "macos")]
fn is_file_search_shortcut(
    key_code: u16,
    modifiers: objc2_app_kit::NSEventModifierFlags,
    repeated: bool,
) -> bool {
    use objc2_app_kit::NSEventModifierFlags as Flags;
    let shortcut_modifiers =
        modifiers & (Flags::Shift | Flags::Control | Flags::Option | Flags::Command);
    !repeated && key_code == 0x23 && shortcut_modifiers == Flags::Command
}

#[cfg(target_os = "macos")]
fn install_shortcut_monitor(app: &tauri::AppHandle) -> std::io::Result<()> {
    use block2::RcBlock;
    use objc2_app_kit::{NSEvent, NSEventMask};
    use std::ptr::NonNull;

    let app = app.clone();
    let handler = RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
        let event_ref = unsafe { event.as_ref() };
        let matched = is_file_search_shortcut(
            event_ref.keyCode(),
            event_ref.modifierFlags(),
            event_ref.isARepeat(),
        );
        if matched {
            if app.state::<FileSearchShortcutState>().request() {
                let _ = app.emit("search-files-requested", ());
            }
            std::ptr::null_mut()
        } else {
            event.as_ptr()
        }
    });
    let monitor = unsafe {
        NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::KeyDown, &handler)
    }
    .ok_or_else(|| std::io::Error::other("failed to install the macOS shortcut monitor"))?;
    // The shortcut monitor intentionally lives until process exit.
    std::mem::forget(monitor);
    Ok(())
}

#[tauri::command]
fn exit_application(app: tauri::AppHandle, state: tauri::State<'_, ExitState>) {
    state.approve_exit();
    app.exit(0);
}

#[tauri::command]
fn mark_file_search_ready(state: tauri::State<'_, FileSearchShortcutState>) -> bool {
    state.mark_ready()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(OpenRequestState::default())
        .manage(SearchState::default())
        .manage(WatchState::default())
        .manage(ExitState::default())
        .manage(FileSearchShortcutState::default())
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            for argument in args.into_iter().skip(1) {
                dispatch_or_queue(app, Path::new(&argument));
            }
            show_main_window(app);
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
            mark_file_search_ready,
            document::read_document,
            document::write_document,
            document::read_local_image,
            open_requests::take_pending_open,
            recovery::load_recovery,
            recovery::persist_recovery,
            search::search_documents,
            watch::watch_document,
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            install_shortcut_monitor(app.handle())?;
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
            show_main_window(app);
        }
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen {
            has_visible_windows: false,
            ..
        } => show_main_window(app),
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
    use super::{ExitState, FileSearchShortcutState};

    #[cfg(target_os = "macos")]
    use super::is_file_search_shortcut;

    #[test]
    fn app_handle_exit_stays_blocked_until_frontend_approval() {
        let state = ExitState::default();

        assert!(state.should_prevent_exit());
        assert!(state.should_prevent_exit());

        state.approve_exit();

        assert!(!state.should_prevent_exit());
    }

    #[test]
    fn file_search_shortcut_replays_one_startup_request() {
        let state = FileSearchShortcutState::default();

        assert!(!state.request());
        assert!(state.mark_ready());
        assert!(!state.mark_ready());
        assert!(state.request());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn physical_command_p_matches_without_layout_or_caps_lock_dependence() {
        use objc2_app_kit::NSEventModifierFlags as Flags;

        assert!(is_file_search_shortcut(
            0x23,
            Flags::Command | Flags::CapsLock,
            false,
        ));
        assert!(!is_file_search_shortcut(
            0x23,
            Flags::Command | Flags::Shift,
            false
        ));
        assert!(!is_file_search_shortcut(0x28, Flags::Command, false));
        assert!(!is_file_search_shortcut(0x23, Flags::Command, true));
    }
}
