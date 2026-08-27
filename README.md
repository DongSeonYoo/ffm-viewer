# FFM Viewer

**Files, fast.**

FFM Viewer is a lightweight Tauri desktop app for Markdown, JSON, plain text, YAML, TOML, and common image files. Files stay on your machine.

## Install on macOS

The current release supports Apple Silicon Macs (M1 or newer).

```bash
git clone https://github.com/DongSeonYoo/ffm-viewer.git
cd ffm-viewer
./install.sh
```

The installer downloads the latest release, verifies its SHA-256 checksum, and installs `FFM Viewer.app` in `~/Applications`. It then registers and opens the app, so you can find **FFM Viewer** with Spotlight.

This personal build uses an ad-hoc signature rather than Apple notarization. On first launch, macOS may ask you to allow FFM Viewer in **System Settings → Privacy & Security**.

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
pnpm test:install
pnpm build:web
cargo test --manifest-path src-tauri/Cargo.toml
```

Build a release bundle:

```bash
pnpm build
```

Build the latest local test image. This replaces `FFM_dev.dmg`, installs
`/Applications/FFM_dev.app`, registers it with macOS, and launches it:

```bash
pnpm build:dev-dmg
```

## Publish a release

Set the app version in `src-tauri/tauri.conf.json`, then push a matching tag:

```bash
git tag v0.1.1
git push origin v0.1.1
```

The release workflow tests the project, builds the Apple Silicon app on GitHub's macOS runner, verifies its ad-hoc signature, and publishes the ZIP plus its SHA-256 checksum. `install.sh` always installs the latest published release.
