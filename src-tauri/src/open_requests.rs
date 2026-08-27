use serde::Serialize;
use std::path::Path;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Default)]
struct OpenRequestInner {
    frontend_ready: bool,
    pending: Option<String>,
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
    #[cfg(test)]
    pub fn queue(&self, path: String) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.pending = Some(path);
        }
    }

    pub fn mark_ready_and_take(&self) -> Option<String> {
        let mut inner = self.inner.lock().ok()?;
        inner.frontend_ready = true;
        inner.pending.take()
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
            inner.pending = Some(path);
            None
        }
    }
}

pub fn is_supported_path(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .is_some_and(|extension| matches!(extension.as_str(), "md" | "markdown" | "json"))
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
pub fn take_pending_open(state: tauri::State<'_, OpenRequestState>) -> Option<String> {
    state.mark_ready_and_take()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_only_the_latest_startup_request() {
        let state = OpenRequestState::default();
        state.queue("/tmp/first.md".into());
        state.queue("/tmp/latest.json".into());

        assert_eq!(state.mark_ready_and_take(), Some("/tmp/latest.json".into()));
        assert_eq!(state.mark_ready_and_take(), None);
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
}
