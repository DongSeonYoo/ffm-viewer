# FFM Viewer

**Files, fast.**

FFM Viewer is a lightweight Tauri desktop app that renders Markdown as a clean reading surface and JSON as a collapsible tree. Files stay on your machine.

## Development

Requirements:

- Node.js and pnpm
- Rust
- Tauri system prerequisites for your operating system

Install dependencies and launch the desktop app:

```bash
pnpm install
pnpm tauri dev
```

Run the automated checks:

```bash
pnpm test
pnpm build:web
cargo test --manifest-path src-tauri/Cargo.toml
```

Build a release bundle:

```bash
pnpm build
```
