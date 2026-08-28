use frizbee::{CaseMatching, Config, Matcher};
use ignore::{DirEntry, WalkBuilder, WalkState};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use unicode_normalization::UnicodeNormalization;

const MAX_QUERY_CHARACTERS: usize = 200;
const MAX_RESULTS: usize = 100;

struct Candidate {
    path: String,
    basename: String,
}

impl AsRef<str> for Candidate {
    fn as_ref(&self) -> &str {
        &self.basename
    }
}

#[derive(Clone, Default)]
pub struct SearchState {
    cache: Arc<Mutex<Option<Vec<Candidate>>>>,
}

struct Collector<'a> {
    candidates: &'a Mutex<Vec<Candidate>>,
    current: Vec<Candidate>,
}

impl Collector<'_> {
    fn push(&mut self, candidate: Candidate) {
        self.current.push(candidate);
    }
}

impl Drop for Collector<'_> {
    fn drop(&mut self) {
        if let Ok(mut candidates) = self.candidates.lock() {
            candidates.append(&mut self.current);
        }
    }
}

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

fn include_entry(entry: &DirEntry) -> bool {
    if entry.depth() == 0 {
        return true;
    }
    entry.file_name().to_str().is_some_and(|name| {
        !(name.starts_with('.')
            || matches!(name, "Library" | "node_modules")
            || entry.depth() == 1 && matches!(name, "Music" | "Movies"))
    })
}

fn candidate(entry: &DirEntry) -> Option<Candidate> {
    if !entry
        .file_type()
        .is_some_and(|file_type| file_type.is_file())
        || !crate::open_requests::is_supported_path(entry.path())
    {
        return None;
    }
    let path = entry.path().to_str()?.to_owned();
    let basename = entry.file_name().to_str()?.nfc().collect();
    Some(Candidate { path, basename })
}

fn collect_candidates(root: &Path) -> Vec<Candidate> {
    let candidates = Mutex::new(Vec::new());
    let mut builder = WalkBuilder::new(root);
    builder
        .standard_filters(true)
        .follow_links(false)
        .threads(4)
        .filter_entry(include_entry);
    builder.build_parallel().run(|| {
        let mut collector = Collector {
            candidates: &candidates,
            current: Vec::new(),
        };
        Box::new(move |entry| {
            if let Ok(entry) = entry {
                if let Some(candidate) = candidate(&entry) {
                    collector.push(candidate);
                }
            }
            WalkState::Continue
        })
    });

    let mut candidates = candidates.into_inner().unwrap_or_default();
    candidates.sort_unstable_by(|left: &Candidate, right| left.path.cmp(&right.path));
    candidates
}

fn match_candidates(candidates: &[Candidate], query: &str) -> Vec<String> {
    let config = Config::default()
        .max_typos(Some(0))
        .casing(CaseMatching::Ignore);
    Matcher::new(query, &config)
        .match_list(candidates)
        .into_iter()
        .take(MAX_RESULTS)
        .map(|matched| candidates[matched.index as usize].path.clone())
        .collect()
}

fn search_documents_in(
    state: &SearchState,
    root: &Path,
    query: &str,
    refresh: bool,
) -> Result<Vec<String>, String> {
    let query = validate_query(query)?.to_owned();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    if !root.is_absolute() {
        return Err("The search root must be an absolute path.".into());
    }
    let query = query.nfc().collect::<String>();
    let mut cache = state
        .cache
        .lock()
        .map_err(|_| "The filename cache is unavailable.".to_string())?;
    let candidates = if refresh {
        cache.insert(collect_candidates(root))
    } else {
        cache.get_or_insert_with(|| collect_candidates(root))
    };
    Ok(match_candidates(candidates, &query))
}

fn home_root() -> Result<PathBuf, String> {
    let root = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "The home folder is unavailable.".to_string())?;
    if !root.is_absolute() {
        return Err("The home folder must be an absolute path.".into());
    }
    Ok(root)
}

#[tauri::command]
pub async fn search_documents(
    query: String,
    refresh: bool,
    state: tauri::State<'_, SearchState>,
) -> Result<Vec<String>, String> {
    let query = validate_query(&query)?.to_owned();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let root = home_root()?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        search_documents_in(&state, &root, &query, refresh)
    })
    .await
    .map_err(|error| format!("Filename search task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::{search_documents_in, validate_query, SearchState};
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};

    static FIXTURE_ID: AtomicU64 = AtomicU64::new(0);

    struct Fixture {
        root: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let id = FIXTURE_ID.fetch_add(1, Ordering::Relaxed);
            let root =
                std::env::temp_dir().join(format!("ffm-search-test-{}-{id}", std::process::id()));
            fs::create_dir_all(&root).expect("create search fixture");
            Self { root }
        }

        fn file(&self, relative: &str) -> PathBuf {
            let path = self.root.join(relative);
            fs::create_dir_all(path.parent().expect("fixture file parent"))
                .expect("create fixture directory");
            fs::write(&path, b"fixture").expect("write search fixture");
            path
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn search(state: &SearchState, root: &Path, query: &str, refresh: bool) -> Vec<String> {
        search_documents_in(state, root, query, refresh).expect("search fixture")
    }

    fn file_names(paths: Vec<String>) -> Vec<String> {
        paths
            .into_iter()
            .map(|path| {
                Path::new(&path)
                    .file_name()
                    .expect("result filename")
                    .to_string_lossy()
                    .into_owned()
            })
            .collect()
    }

    #[test]
    fn prunes_noisy_and_hidden_entries_before_collecting_files() {
        let fixture = Fixture::new();
        let visible = fixture.file("project/needle-visible.md");
        for path in [
            ".needle-hidden.md",
            ".hidden/needle.md",
            "Library/needle.md",
            ".Trash/needle.md",
            ".git/needle.md",
            "project/node_modules/needle.md",
        ] {
            fixture.file(path);
        }

        assert_eq!(
            search(&SearchState::default(), &fixture.root, "needle", true),
            vec![visible.to_string_lossy()]
        );
    }

    #[test]
    fn skips_home_media_folders_without_hiding_project_folders_with_the_same_name() {
        let fixture = Fixture::new();
        fixture.file("Music/needle-music.md");
        fixture.file("Movies/needle-movie.md");
        let expected = fixture.file("project/Music/needle-project.md");

        assert_eq!(
            search(&SearchState::default(), &fixture.root, "needle", true),
            vec![expected.to_string_lossy()]
        );
    }

    #[test]
    fn collects_only_extensions_supported_by_the_document_reader() {
        let fixture = Fixture::new();
        let expected = [
            "avif", "gif", "jpeg", "jpg", "json", "markdown", "md", "png", "svg", "toml", "txt",
            "webp", "yaml", "yml",
        ];
        for extension in expected {
            fixture.file(&format!("supported.{extension}"));
        }
        fixture.file("supported.exe");

        assert_eq!(
            file_names(search(
                &SearchState::default(),
                &fixture.root,
                "supported",
                true
            )),
            expected.map(|extension| format!("supported.{extension}"))
        );
    }

    #[test]
    fn matches_fuzzy_abbreviations() {
        let fixture = Fixture::new();
        let expected = fixture.file("deti_user_schema_v1.0.json");

        assert_eq!(
            search(&SearchState::default(), &fixture.root, "dusrsc", true),
            vec![expected.to_string_lossy()]
        );
    }

    #[test]
    fn matches_exact_names_case_insensitively() {
        let fixture = Fixture::new();
        let first = fixture.file("a/ReadMe.MD");
        let second = fixture.file("z/ReadMe.MD");

        assert_eq!(
            search(&SearchState::default(), &fixture.root, "README.MD", true),
            vec![first.to_string_lossy(), second.to_string_lossy()]
        );
    }

    #[test]
    fn normalizes_decomposed_hangul_file_names() {
        let fixture = Fixture::new();
        let expected = fixture.file("문서검색_분해형_유일.md");

        assert_eq!(
            search(
                &SearchState::default(),
                &fixture.root,
                "문서검색_분해형_유일",
                true
            ),
            vec![expected.to_string_lossy()]
        );
    }

    #[test]
    fn limits_results_to_the_top_100() {
        let fixture = Fixture::new();
        for index in 0..105 {
            fixture.file(&format!("report-{index:03}.md"));
        }

        assert_eq!(
            search(&SearchState::default(), &fixture.root, "report", true).len(),
            100
        );
    }

    #[test]
    fn reuses_the_cache_until_an_explicit_refresh() {
        let fixture = Fixture::new();
        let state = SearchState::default();

        assert!(search(&state, &fixture.root, "cache", true).is_empty());
        let first = fixture.file("cache-first.md");
        assert!(search(&state, &fixture.root, "cache", false).is_empty());
        assert_eq!(
            search(&state, &fixture.root, "cache", true),
            vec![first.to_string_lossy()]
        );

        let second = fixture.file("cache-second.md");
        assert_eq!(
            search(&state, &fixture.root, "cache", false),
            vec![first.to_string_lossy()]
        );
        assert_eq!(
            search(&state, &fixture.root, "cache", true),
            vec![first.to_string_lossy(), second.to_string_lossy()]
        );
    }

    #[test]
    fn rejects_control_characters_and_oversized_queries_without_scanning() {
        let fixture = Fixture::new();
        let state = SearchState::default();
        fixture.file("readme.md");

        assert!(search_documents_in(&state, &fixture.root, "", true)
            .expect("empty search")
            .is_empty());
        assert!(search_documents_in(&state, &fixture.root, "bad\nquery", true).is_err());
        assert!(state.cache.lock().expect("search cache").is_none());
        assert!(validate_query("readme").is_ok());
        assert!(validate_query(&"x".repeat(201)).is_err());
    }
}
