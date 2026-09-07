use crate::document::classify_extension;
use serde::Serialize;
use std::{fs, path::Path};

#[derive(Debug, Serialize)]
pub struct FolderEntry {
    path: String,
    name: String,
    directory: bool,
    supported: bool,
}

#[derive(Debug, Serialize)]
pub struct FolderListing {
    path: String,
    name: String,
    entries: Vec<FolderEntry>,
}

fn list_directory(path: &Path) -> Result<Option<FolderListing>, String> {
    let path = path
        .canonicalize()
        .map_err(|_| "This path could not be found.")?;
    if !path.is_dir() {
        return Ok(None);
    }
    let mut entries = Vec::new();
    for entry in
        fs::read_dir(&path).map_err(|_| "This folder could not be read. Check its permissions.")?
    {
        let entry = entry.map_err(|_| "A folder entry could not be read. Try again.")?;
        let kind = entry
            .file_type()
            .map_err(|_| "A folder entry could not be inspected.")?;
        // Do not follow symbolic links: they may escape the folder or create cycles.
        entries.push(FolderEntry {
            path: entry.path().to_string_lossy().into_owned(),
            name: entry.file_name().to_string_lossy().into_owned(),
            directory: kind.is_dir(),
            supported: kind.is_file() && classify_extension(&entry.path()).is_ok(),
        });
    }
    entries.sort_by_cached_key(|entry| {
        (
            !entry.directory,
            entry.name.to_lowercase(),
            entry.name.clone(),
        )
    });
    Ok(Some(FolderListing {
        name: path
            .file_name()
            .unwrap_or(path.as_os_str())
            .to_string_lossy()
            .into_owned(),
        path: path.to_string_lossy().into_owned(),
        entries,
    }))
}

#[tauri::command]
pub async fn read_directory(path: String) -> Result<Option<FolderListing>, String> {
    tauri::async_runtime::spawn_blocking(move || list_directory(Path::new(&path)))
        .await
        .map_err(|_| "The folder could not be loaded.".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_one_level_including_unsupported_files_without_following_links() {
        let root = std::env::temp_dir().join(format!(
            "ffm-folders-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(root.join("nested")).unwrap();
        fs::write(root.join("nested/child.md"), "# Child").unwrap();
        fs::write(root.join("README.MD"), "# Hello").unwrap();
        fs::write(root.join("app.exe"), "binary").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&root, root.join("loop")).unwrap();
        let result = list_directory(&root).unwrap().unwrap();
        assert_eq!(result.entries[0].name, "nested");
        assert!(result.entries[0].directory);
        assert!(
            result
                .entries
                .iter()
                .find(|entry| entry.name == "README.MD")
                .unwrap()
                .supported
        );
        assert!(
            !result
                .entries
                .iter()
                .find(|entry| entry.name == "app.exe")
                .unwrap()
                .supported
        );
        assert!(!result.entries.iter().any(|entry| entry.name == "child.md"));
        #[cfg(unix)]
        assert!(
            !result
                .entries
                .iter()
                .find(|entry| entry.name == "loop")
                .unwrap()
                .directory
        );
        assert!(list_directory(&root.join("README.MD")).unwrap().is_none());
        assert!(list_directory(&root.join("missing")).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
