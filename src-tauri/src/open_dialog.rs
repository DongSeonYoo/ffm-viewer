const EXTENSIONS: &[&str] = &[
    "md", "markdown", "json", "txt", "yaml", "yml", "toml", "png", "jpg", "jpeg", "gif", "webp",
    "avif", "svg",
];

#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn choose_documents(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSModalResponseOK, NSOpenPanel};
    use objc2_foundation::{NSArray, NSString};

    let (sender, mut receiver) = tauri::async_runtime::channel(1);
    app.run_on_main_thread(move || {
        let panel = NSOpenPanel::openPanel(MainThreadMarker::new().expect("main-thread dispatch"));
        panel.setCanChooseFiles(true);
        panel.setCanChooseDirectories(true);
        panel.setAllowsMultipleSelection(true);
        panel.setCanCreateDirectories(false);
        panel.setTreatsFilePackagesAsDirectories(false);
        panel.setTitle(Some(&NSString::from_str("Open files or folders")));
        let extensions = EXTENSIONS
            .iter()
            .map(|ext| NSString::from_str(ext))
            .collect::<Vec<_>>();
        // The extension-based API also supports types without a registered UTType.
        #[allow(deprecated)]
        panel.setAllowedFileTypes(Some(&NSArray::from_retained_slice(&extensions)));
        panel.setAllowsOtherFileTypes(false);
        let paths = if panel.runModal() == NSModalResponseOK {
            panel
                .URLs()
                .iter()
                .filter_map(|url| url.path().map(|path| path.to_string()))
                .collect()
        } else {
            Vec::new()
        };
        let _ = sender.try_send(paths);
    })
    .map_err(|error| error.to_string())?;
    receiver
        .recv()
        .await
        .ok_or_else(|| "Open dialog closed unexpectedly".to_owned())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn choose_documents(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (sender, mut receiver) = tauri::async_runtime::channel(1);
    app.dialog()
        .file()
        .add_filter("Developer documents", EXTENSIONS)
        .pick_files(move |files| {
            let paths = files
                .unwrap_or_default()
                .into_iter()
                .filter_map(|file| file.into_path().ok())
                .map(|path| path.to_string_lossy().into_owned())
                .collect();
            let _ = sender.try_send(paths);
        });
    receiver
        .recv()
        .await
        .ok_or_else(|| "Open dialog closed unexpectedly".to_owned())
}
