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

Build the three app channels:

```bash
pnpm build           # FFM Viewer: published release
pnpm build:beta-dmg  # FFM_beta: optimized personal test build
pnpm build:dev-dmg   # FFM_dev: diagnostics-enabled development build
```

The beta and dev commands replace their root-level DMG, install the matching
app in `/Applications`, register it with macOS, and launch it. Their bundle
identifiers and local app data are separate from the published app and from
each other.

## Publish a release

Set the same version in `package.json`, `src-tauri/tauri.conf.json`, and
`src-tauri/Cargo.toml`, then push a matching tag:

```bash
git tag v0.2.0
git push origin v0.2.0
```

The release workflow tests the project, builds the Apple Silicon app on GitHub's macOS runner, verifies its ad-hoc signature, and publishes the ZIP plus its SHA-256 checksum. `install.sh` always installs the latest published release.
