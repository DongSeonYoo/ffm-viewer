use std::collections::HashSet;
use std::ffi::OsStr;
use std::io::BufRead;
use std::path::Path;

const MAX_QUERY_CHARACTERS: usize = 200;
const MAX_RESULTS: usize = 100;

fn validate_query(query: &str) -> Result<&str, String> {
    let query = query.trim();
    if query.chars().count() > MAX_QUERY_CHARACTERS {
        return Err("Search query is too long.".into());
    }
    if query.chars().any(char::is_control) {
        return Err("Search query contains unsupported characters.".into());
    }
    Ok(query)
}

fn is_noisy_path(path: &Path) -> bool {
    path.components().any(|component| {
        matches!(
            component.as_os_str(),
            value if value == OsStr::new("Library")
                || value == OsStr::new(".Trash")
                || value == OsStr::new(".git")
                || value == OsStr::new("node_modules")
        )
    })
}

fn collect_search_results(reader: impl BufRead, limit: usize) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut results = Vec::new();

    for entry in reader.split(0).flatten() {
        let path = String::from_utf8_lossy(&entry).into_owned();
        let candidate = Path::new(&path);
        if path.is_empty()
            || is_noisy_path(candidate)
            || crate::document::classify_extension(candidate).is_err()
            || !seen.insert(path.clone())
        {
            continue;
        }
        results.push(path);
        if results.len() == limit {
            break;
        }
    }
    results
}

#[cfg(target_os = "macos")]
fn search_with_spotlight(query: &str) -> Result<Vec<String>, String> {
    use std::io::BufReader;
    use std::process::{Command, Stdio};

    let mut child = Command::new("/usr/bin/mdfind")
        .args(["-0", "-name", query])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Spotlight search could not start: {error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Spotlight search output is unavailable.".to_string())?;
    let results = collect_search_results(BufReader::new(stdout), MAX_RESULTS);
    let capped = results.len() == MAX_RESULTS;
    if capped {
        let _ = child.kill();
    }
    let status = child
        .wait()
        .map_err(|error| format!("Spotlight search could not finish: {error}"))?;
    if !capped && !status.success() {
        return Err("Spotlight search failed.".into());
    }
    Ok(results)
}

#[cfg(not(target_os = "macos"))]
fn search_with_spotlight(_query: &str) -> Result<Vec<String>, String> {
    Err("File search is available on macOS only.".into())
}

#[tauri::command]
pub async fn search_documents(query: String) -> Result<Vec<String>, String> {
    let query = validate_query(&query)?.to_owned();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    tauri::async_runtime::spawn_blocking(move || search_with_spotlight(&query))
        .await
        .map_err(|error| format!("Spotlight search task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::{collect_search_results, validate_query};
    use std::io::Cursor;

    #[test]
    fn keeps_supported_paths_and_filters_noisy_locations() {
        let input = b"/Users/me/README.md\0/Users/me/Library/hidden.md\0/Users/me/project/node_modules/package.json\0/Users/me/data.json\0/Users/me/program.exe\0";

        assert_eq!(
            collect_search_results(Cursor::new(input), 100),
            vec!["/Users/me/README.md", "/Users/me/data.json"]
        );
    }

    #[test]
    fn caps_results_without_reordering_them() {
        let input = b"/tmp/a.md\0/tmp/b.json\0/tmp/c.txt\0";

        assert_eq!(
            collect_search_results(Cursor::new(input), 2),
            vec!["/tmp/a.md", "/tmp/b.json"]
        );
    }

    #[test]
    fn rejects_control_characters_and_oversized_queries() {
        assert!(validate_query("readme").is_ok());
        assert!(validate_query("bad\nquery").is_err());
        assert!(validate_query(&"x".repeat(201)).is_err());
    }
}
