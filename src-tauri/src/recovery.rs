use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::Manager;

const MAX_RECOVERY_BYTES: u64 = 50 * 1024 * 1024;
const RECOVERY_FILE: &str = "scratch-recovery.json";

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RecoveryKind {
    Markdown,
    Json,
    Text,
    Yaml,
    Toml,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryScratch {
    pub name: String,
    pub kind: RecoveryKind,
    pub content: String,
}

fn temporary_path(path: &Path) -> PathBuf {
    path.with_extension("json.tmp")
}

fn remove_if_present(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("Scratch recovery could not be updated.".into()),
    }
}

fn persist_recovery_at(path: &Path, scratches: &[RecoveryScratch]) -> Result<(), String> {
    let temporary = temporary_path(path);
    if scratches.is_empty() {
        remove_if_present(&temporary)?;
        return remove_if_present(path);
    }

    let bytes = serde_json::to_vec(scratches)
        .map_err(|_| "Scratch recovery could not be encoded.".to_string())?;
    if bytes.len() as u64 > MAX_RECOVERY_BYTES {
        return Err("Scratch recovery is larger than the 50 MB safety limit.".into());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "Scratch recovery folder is unavailable.".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|_| "Scratch recovery folder is unavailable.".to_string())?;

    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&temporary)
            .map_err(|_| "Scratch recovery could not be written.".to_string())?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "Scratch recovery could not be written.".to_string())?;
        fs::rename(&temporary, path)
            .map_err(|_| "Scratch recovery could not be committed.".to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

fn load_recovery_at(path: &Path) -> Result<Vec<RecoveryScratch>, String> {
    let metadata = match path.metadata() {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err("Scratch recovery could not be inspected.".into()),
    };
    if !metadata.is_file() || metadata.len() > MAX_RECOVERY_BYTES {
        return Err("Scratch recovery is not a readable file under 50 MB.".into());
    }
    let bytes = fs::read(path).map_err(|_| "Scratch recovery could not be read.".to_string())?;
    serde_json::from_slice(&bytes)
        .map_err(|_| "Scratch recovery contains invalid data.".to_string())
}

fn recovery_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join(RECOVERY_FILE))
        .map_err(|_| "Scratch recovery folder is unavailable.".to_string())
}

#[tauri::command]
pub fn load_recovery(app: tauri::AppHandle) -> Result<Vec<RecoveryScratch>, String> {
    load_recovery_at(&recovery_path(&app)?)
}

#[tauri::command]
pub fn persist_recovery(
    app: tauri::AppHandle,
    scratches: Vec<RecoveryScratch>,
) -> Result<(), String> {
    persist_recovery_at(&recovery_path(&app)?, &scratches)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);

    fn temp_path() -> PathBuf {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be valid")
            .as_nanos();
        let sequence = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir()
            .join(format!(
                "ffm-recovery-test-{}-{timestamp}-{sequence}",
                std::process::id()
            ))
            .join("scratch-recovery.json")
    }

    #[test]
    fn persists_loads_and_removes_scratch_recovery() {
        let path = temp_path();
        let scratches = vec![
            RecoveryScratch {
                name: "Untitled 1".into(),
                kind: RecoveryKind::Markdown,
                content: "# Keep me".into(),
            },
            RecoveryScratch {
                name: "Untitled 2".into(),
                kind: RecoveryKind::Json,
                content: r#"{"id":9223372036854775807}"#.into(),
            },
        ];

        persist_recovery_at(&path, &scratches).expect("recovery should persist");
        assert_eq!(
            load_recovery_at(&path).expect("recovery should load"),
            scratches
        );
        assert!(!path.with_extension("json.tmp").exists());

        persist_recovery_at(&path, &[]).expect("empty recovery should clear");
        assert!(!path.exists());
        assert!(load_recovery_at(&path)
            .expect("missing recovery should be empty")
            .is_empty());

        if let Some(parent) = path.parent() {
            let _ = fs::remove_dir_all(parent);
        }
    }
}
