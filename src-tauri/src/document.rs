use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use percent_encoding::percent_decode_str;
use serde::Serialize;
use std::fs;
use std::io::Write;
use std::path::Path;

const MAX_DOCUMENT_BYTES: u64 = 50 * 1024 * 1024;
const MAX_IMAGE_BYTES: u64 = 10 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DocumentKind {
    Markdown,
    Json,
    Text,
    Yaml,
    Toml,
    Image,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentPayload {
    pub path: String,
    pub name: String,
    pub kind: DocumentKind,
    pub content: String,
}

pub fn classify_extension(path: &Path) -> Result<DocumentKind, String> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase);

    match extension.as_deref() {
        Some("md" | "markdown") => Ok(DocumentKind::Markdown),
        Some("json") => Ok(DocumentKind::Json),
        Some("txt") => Ok(DocumentKind::Text),
        Some("yaml" | "yml") => Ok(DocumentKind::Yaml),
        Some("toml") => Ok(DocumentKind::Toml),
        Some("png" | "jpg" | "jpeg" | "gif" | "webp" | "avif" | "svg") => {
            Ok(DocumentKind::Image)
        }
        _ => Err("This file type is not supported.".into()),
    }
}

pub fn read_document_from_path(path: &Path) -> Result<DocumentPayload, String> {
    let canonical = path
        .canonicalize()
        .map_err(|_| "The selected document could not be found.".to_string())?;
    let metadata = canonical
        .metadata()
        .map_err(|_| "The selected document could not be inspected.".to_string())?;
    if !metadata.is_file() {
        return Err("Select a Markdown or JSON file, not a directory.".into());
    }
    if metadata.len() > MAX_DOCUMENT_BYTES {
        return Err("This document is larger than the 50 MB safety limit.".into());
    }

    let kind = classify_extension(&canonical)?;
    let bytes =
        fs::read(&canonical).map_err(|_| "The selected document could not be read.".to_string())?;
    let content = if kind == DocumentKind::Image {
        // ponytail: data URLs keep image delivery CSP-safe; use the asset protocol only if large-image profiling proves copies costly.
        let mime = image_mime(&canonical, true)?;
        format!("data:{mime};base64,{}", BASE64.encode(bytes))
    } else {
        String::from_utf8(bytes)
            .map_err(|_| "This document is not valid UTF-8 text.".to_string())?
            .trim_start_matches('\u{feff}')
            .to_string()
    };
    let name = canonical
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "The selected document has an invalid file name.".to_string())?
        .to_string();
    Ok(DocumentPayload {
        path: canonical.to_string_lossy().into_owned(),
        name,
        kind,
        content,
    })
}

#[tauri::command]
pub fn read_document(path: String) -> Result<DocumentPayload, String> {
    read_document_from_path(Path::new(&path))
}

fn write_document_to_path(path: &Path, content: &str) -> Result<(), String> {
    if content.len() as u64 > MAX_DOCUMENT_BYTES {
        return Err("This document is larger than the 50 MB safety limit.".into());
    }
    if classify_extension(path)? == DocumentKind::Image {
        return Err("Scratch content can only be saved as a text document.".into());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "The save folder is unavailable.".to_string())?
        .canonicalize()
        .map_err(|_| "The save folder is unavailable.".to_string())?;
    let name = path
        .file_name()
        .ok_or_else(|| "Choose a valid file name.".to_string())?;
    let target = parent.join(name);
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&target)
        .map_err(|_| "Choose a new file name. FFM will not overwrite an existing file.".to_string())?;
    if file.write_all(content.as_bytes()).is_err() || file.sync_all().is_err() {
        drop(file);
        let _ = fs::remove_file(&target);
        return Err("The document could not be saved.".into());
    }
    Ok(())
}

#[tauri::command]
pub fn write_document(path: String, content: String) -> Result<(), String> {
    write_document_to_path(Path::new(&path), &content)
}

fn image_mime(path: &Path, allow_svg: bool) -> Result<&'static str, String> {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("png") => Ok("image/png"),
        Some("jpg" | "jpeg") => Ok("image/jpeg"),
        Some("gif") => Ok("image/gif"),
        Some("webp") => Ok("image/webp"),
        Some("avif") => Ok("image/avif"),
        Some("svg") if allow_svg => Ok("image/svg+xml"),
        _ => Err("This local image format is not supported.".into()),
    }
}

fn read_local_image_data_url(document: &Path, source: &str) -> Result<String, String> {
    let document = document
        .canonicalize()
        .map_err(|_| "The Markdown document could not be found.".to_string())?;
    let base = document
        .parent()
        .ok_or_else(|| "The Markdown document folder is unavailable.".to_string())?
        .canonicalize()
        .map_err(|_| "The Markdown document folder is unavailable.".to_string())?;
    let clean_source = source.split(['?', '#']).next().unwrap_or_default();
    let decoded_source = percent_decode_str(clean_source)
        .decode_utf8()
        .map_err(|_| "The local image path is not valid UTF-8.".to_string())?;
    let source_path = Path::new(decoded_source.as_ref());
    if source_path.is_absolute() {
        return Err("Local images must stay inside the document folder.".into());
    }

    let candidate = base
        .join(source_path)
        .canonicalize()
        .map_err(|_| "The local image could not be found.".to_string())?;
    if !candidate.starts_with(&base) {
        return Err("Local images must stay inside the document folder.".into());
    }
    let mime = image_mime(&candidate, false)?;
    let metadata = candidate
        .metadata()
        .map_err(|_| "The local image could not be inspected.".to_string())?;
    if !metadata.is_file() || metadata.len() > MAX_IMAGE_BYTES {
        return Err("The local image is not a readable file under 10 MB.".into());
    }
    let bytes =
        fs::read(candidate).map_err(|_| "The local image could not be read.".to_string())?;
    Ok(format!("data:{mime};base64,{}", BASE64.encode(bytes)))
}

#[tauri::command]
pub fn read_local_image(document_path: String, source: String) -> Result<Option<String>, String> {
    read_local_image_data_url(Path::new(&document_path), &source).map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);

    fn temp_file(name: &str, contents: &[u8]) -> PathBuf {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be valid")
            .as_nanos();
        let sequence = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
        let directory = std::env::temp_dir().join(format!(
            "ffm-viewer-test-{}-{timestamp}-{sequence}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).expect("temp directory should be created");
        let path = directory.join(name);
        fs::write(&path, contents).expect("fixture should be written");
        path
    }

    #[test]
    fn reads_supported_markdown_documents() {
        let path = temp_file("README.md", b"# Hello");
        let payload = read_document_from_path(&path).expect("document should load");

        assert_eq!(payload.kind, DocumentKind::Markdown);
        assert_eq!(payload.name, "README.md");
        assert_eq!(payload.content, "# Hello");
    }

    #[test]
    fn reads_supported_json_documents() {
        let path = temp_file("response.JSON", br#"{"ready":true}"#);
        let payload = read_document_from_path(&path).expect("document should load");

        assert_eq!(payload.kind, DocumentKind::Json);
    }

    #[test]
    fn reads_plain_text_and_config_documents() {
        for (name, kind) in [
            ("notes.txt", DocumentKind::Text),
            ("config.yaml", DocumentKind::Yaml),
            ("config.YML", DocumentKind::Yaml),
            ("config.toml", DocumentKind::Toml),
        ] {
            let path = temp_file(name, b"key = value");
            let payload = read_document_from_path(&path).expect("text document should load");
            assert_eq!(payload.kind, kind);
            assert_eq!(payload.content, "key = value");
        }
    }

    #[test]
    fn reads_image_documents_as_inert_data_urls() {
        for (name, mime, bytes) in [
            ("pixel.png", "image/png", &b"png"[..]),
            ("photo.jpeg", "image/jpeg", &b"jpeg"[..]),
            (
                "vector.svg",
                "image/svg+xml",
                &b"<svg><script>alert(1)</script></svg>"[..],
            ),
        ] {
            let path = temp_file(name, bytes);
            let payload = read_document_from_path(&path).expect("image document should load");
            assert_eq!(payload.kind, DocumentKind::Image);
            assert!(payload.content.starts_with(&format!("data:{mime};base64,")));
            assert!(!payload.content.contains("<script"));
        }
    }

    #[test]
    fn rejects_unsupported_extensions() {
        let path = temp_file("notes.exe", b"hello");
        let error = read_document_from_path(&path).expect_err("executables are out of scope");

        assert!(error.contains("supported"));
    }

    #[test]
    fn writes_scratch_text_to_a_supported_path() {
        let seed = temp_file("seed.txt", b"");
        let path = seed.parent().expect("temp directory").join("saved.md");

        write_document_to_path(&path, "# Saved").expect("scratch should save");

        assert_eq!(fs::read_to_string(&path).expect("saved contents"), "# Saved");
    }

    #[test]
    fn refuses_to_overwrite_an_image_from_scratch() {
        let seed = temp_file("seed.txt", b"");
        let path = seed.parent().expect("temp directory").join("image.png");

        let error = write_document_to_path(&path, "not an image")
            .expect_err("scratch must not write image extensions");

        assert!(error.contains("text"));
        assert!(!path.exists());
    }

    #[test]
    fn refuses_to_overwrite_an_existing_text_file() {
        let path = temp_file("existing.md", b"original");

        let error = write_document_to_path(&path, "replacement")
            .expect_err("existing user files must stay untouched");

        assert!(error.contains("not overwrite"));
        assert_eq!(fs::read_to_string(path).expect("original remains"), "original");
    }

    #[test]
    fn rejects_invalid_utf8_without_leaking_the_path() {
        let path = temp_file("broken.md", &[0xff, 0xfe, 0xfd]);
        let error = read_document_from_path(&path).expect_err("invalid UTF-8 should fail");

        assert!(error.contains("UTF-8"));
        assert!(!error.contains(path.to_string_lossy().as_ref()));
    }

    #[test]
    fn reads_allowed_images_below_the_document_directory() {
        let document = temp_file("README.md", b"![pixel](assets/pixel.png)");
        let image = document.parent().expect("parent").join("assets/pixel.png");
        fs::create_dir_all(image.parent().expect("image parent")).expect("asset directory");
        fs::write(&image, [0x89, b'P', b'N', b'G']).expect("image fixture");

        let data_url = read_local_image_data_url(&document, "assets/pixel.png")
            .expect("local image should load");
        assert!(data_url.starts_with("data:image/png;base64,"));
    }

    #[test]
    fn decodes_percent_encoded_image_names() {
        let document = temp_file("README.md", b"![diagram](my%20diagram.png)");
        let image = document.parent().expect("parent").join("my diagram.png");
        fs::write(&image, [0x89, b'P', b'N', b'G']).expect("image fixture");

        let data_url = read_local_image_data_url(&document, "my%20diagram.png")
            .expect("encoded local image should load");
        assert!(data_url.starts_with("data:image/png;base64,"));
    }

    #[test]
    fn blocks_percent_encoded_traversal() {
        let document = temp_file("README.md", b"![secret](%2e%2e/secret.png)");
        let secret = document
            .parent()
            .expect("parent")
            .parent()
            .expect("grandparent")
            .join("secret.png");
        fs::write(&secret, [0x89, b'P', b'N', b'G']).expect("secret fixture");

        let error = read_local_image_data_url(&document, "%2e%2e/secret.png")
            .expect_err("encoded traversal should be rejected");
        assert!(error.contains("document folder"));
    }

    #[test]
    fn blocks_images_outside_the_document_directory() {
        let document = temp_file("README.md", b"![secret](../secret.png)");
        let secret = document
            .parent()
            .expect("parent")
            .parent()
            .expect("grandparent")
            .join("secret.png");
        fs::write(&secret, [0x89, b'P', b'N', b'G']).expect("secret fixture");

        let error = read_local_image_data_url(&document, "../secret.png")
            .expect_err("path traversal should be rejected");
        assert!(error.contains("document folder"));
    }

    #[test]
    fn blocks_active_svg_images() {
        let document = temp_file("README.md", b"![vector](vector.svg)");
        let image = document.parent().expect("parent").join("vector.svg");
        fs::write(&image, b"<svg><script>alert(1)</script></svg>").expect("svg fixture");

        let error = read_local_image_data_url(&document, "vector.svg")
            .expect_err("SVG is outside the safe image allow-list");
        assert!(error.contains("image format"));
    }
}
