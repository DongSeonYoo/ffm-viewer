use serde::Serialize;
use std::path::Path;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Default)]
struct OpenRequestInner {
    frontend_ready: bool,
    pending: Vec<String>,
}

#[derive(Default)]
pub struct OpenRequestState {
    inner: Mutex<OpenRequestInner>,
}

#[derive(Clone, Serialize)]
struct PathEvent {
    path: String,
}

impl OpenRequestState {
    pub fn mark_ready_and_take(&self) -> Vec<String> {
        let Ok(mut inner) = self.inner.lock() else {
            return Vec::new();
        };
        inner.frontend_ready = true;
        std::mem::take(&mut inner.pending)
    }

    #[cfg(test)]
    pub fn is_ready(&self) -> bool {
        self.inner
            .lock()
            .map(|inner| inner.frontend_ready)
            .unwrap_or(false)
    }

    fn deliver_or_queue(&self, path: String) -> Option<String> {
        let mut inner = self.inner.lock().ok()?;
        if inner.frontend_ready {
            Some(path)
        } else {
            inner.pending.push(path);
            None
        }
    }
}

pub fn is_supported_path(path: &Path) -> bool {
    crate::document::classify_extension(path).is_ok()
}

pub fn dispatch_or_queue(app: &AppHandle, path: &Path) {
    if !is_supported_path(path) {
        return;
    }
    let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let value = canonical.to_string_lossy().into_owned();
    let state = app.state::<OpenRequestState>();
    if let Some(path) = state.deliver_or_queue(value) {
        let _ = app.emit("file-open-requested", PathEvent { path });
    }
}

#[tauri::command]
pub fn take_pending_open(state: tauri::State<'_, OpenRequestState>) -> Vec<String> {
    state.mark_ready_and_take()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_all_startup_requests_in_order() {
        let state = OpenRequestState::default();
        assert_eq!(state.deliver_or_queue("/tmp/first.md".into()), None);
        assert_eq!(state.deliver_or_queue("/tmp/latest.json".into()), None);

        assert_eq!(
            state.mark_ready_and_take(),
            vec!["/tmp/first.md".to_string(), "/tmp/latest.json".to_string()]
        );
        assert!(state.mark_ready_and_take().is_empty());
    }

    #[test]
    fn reports_when_the_frontend_is_ready_for_events() {
        let state = OpenRequestState::default();

        assert!(!state.is_ready());
        state.mark_ready_and_take();
        assert!(state.is_ready());
        assert_eq!(
            state.deliver_or_queue("/tmp/later.md".into()),
            Some("/tmp/later.md".into())
        );
    }

    #[test]
    fn accepts_every_registered_document_family() {
        for path in [
            "README.md",
            "data.json",
            "notes.txt",
            "config.yaml",
            "config.yml",
            "config.toml",
            "pixel.png",
            "photo.jpeg",
            "vector.svg",
        ] {
            assert!(
                is_supported_path(Path::new(path)),
                "{path} should be supported"
            );
        }
        assert!(!is_supported_path(Path::new("program.exe")));
    }
}
