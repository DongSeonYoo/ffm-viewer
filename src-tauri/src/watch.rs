use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

#[derive(Default)]
pub struct WatchState {
    watcher: Mutex<Option<RecommendedWatcher>>,
}

#[derive(Clone, Serialize)]
struct PathEvent {
    path: String,
}

pub fn path_matches(candidate: &Path, target: &Path) -> bool {
    candidate == target
}

#[tauri::command]
pub fn watch_document(
    app: AppHandle,
    state: tauri::State<'_, WatchState>,
    path: String,
) -> Result<(), String> {
    let target = PathBuf::from(path)
        .canonicalize()
        .map_err(|_| "The document can no longer be watched.".to_string())?;
    let parent = target
        .parent()
        .ok_or_else(|| "The document folder could not be watched.".to_string())?
        .to_path_buf();
    let target_for_event = target.clone();
    let target_string = target.to_string_lossy().into_owned();
    let mut watcher = notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
        let Ok(event) = result else { return };
        if !event
            .paths
            .iter()
            .any(|candidate| path_matches(candidate, &target_for_event))
        {
            return;
        }

        let _ = app.emit(
            "document-changed",
            PathEvent {
                path: target_string.clone(),
            },
        );
    })
    .map_err(|_| "The document watcher could not be started.".to_string())?;

    watcher
        .watch(&parent, RecursiveMode::NonRecursive)
        .map_err(|_| "The document folder could not be watched.".to_string())?;
    let mut active = state
        .watcher
        .lock()
        .map_err(|_| "The document watcher is unavailable.".to_string())?;
    *active = Some(watcher);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn matches_only_the_active_document_path() {
        let target = Path::new("/tmp/project/config.json");

        assert!(path_matches(Path::new("/tmp/project/config.json"), target));
        assert!(!path_matches(
            Path::new("/tmp/project/.config.json.swp"),
            target
        ));
        assert!(!path_matches(Path::new("/tmp/other/config.json"), target));
    }
}
